import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {recentSessions,matchSessions,sessionDirectory,resumeArgs,pickSession} from '../src/terminal-pickup.mjs';
import {ClaudeTerminal} from '../src/claude-terminal.mjs';
import {Providers} from '../src/providers.mjs';
import {Store} from '../src/store.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ar-pickup-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
const sessions=[
 {id:'claude:aaaaaaaa-0000-4000-8000-000000000001',provider:'claude',providerId:'aaaaaaaa-0000-4000-8000-000000000001',title:'Acme launch ad concepts',cwd:'/Users/me',lastCompletedAt:3},
 {id:'claude:bbbbbbbb-0000-4000-8000-000000000002',provider:'claude',providerId:'bbbbbbbb-0000-4000-8000-000000000002',title:'Flaky build investigation',cwd:'/Users/me/Widgets',lastCompletedAt:5},
 {id:'codex:cccccccc',provider:'codex',providerId:'cccccccc',title:'Etching model weights',cwd:'/Users/me',lastCompletedAt:4},
];
test('pickup lists conversations in phone order and matches by words or ID',()=>{
 assert.deepEqual(recentSessions(sessions).map(s=>s.provider+':'+s.title.split(' ')[0]),['claude:Flaky','codex:Etching','claude:Acme']);
 assert.deepEqual(recentSessions(sessions,'claude').map(s=>s.provider),['claude','claude']);
 assert.equal(matchSessions(sessions,'ad acme')[0].title,'Acme launch ad concepts');
 assert.equal(matchSessions(sessions,'widgets').length,1);
 assert.equal(matchSessions(sessions,'bbbbbbbb-00').length,1);
 assert.deepEqual(resumeArgs(sessions[0]),['--resume',sessions[0].providerId]);
 assert.deepEqual(resumeArgs(sessions[2]),['resume','cccccccc']);
});
test('pickup resumes Claude from the directory that owns its transcript',t=>{
 const root=fixture(t);const cwd=join(root,'work','tool-results');mkdirSync(cwd,{recursive:true});
 const project=join(root,'work').replace(/[^A-Za-z0-9]/g,'-');
 assert.equal(sessionDirectory({provider:'claude',cwd,transcript:'/x/projects/'+project+'/id.jsonl'}),join(root,'work'));
 assert.equal(sessionDirectory({provider:'codex',cwd}),cwd);
 assert.equal(sessionDirectory({provider:'claude',cwd:join(root,'gone')},'/fallback'),'/fallback');
});
test('pickup chooses by number, by a unique search, or cancels on Enter',async()=>{
 const output=new PassThrough();output.resume();
 const ask=async(answer,query)=>{const input=new PassThrough();setTimeout(()=>input.write(answer+'\n'),10);return pickSession(sessions,{query,input,output});};
 assert.equal((await ask('2')).provider,'codex');
 assert.equal((await ask('flaky')).title,'Flaky build investigation');
 assert.equal(await ask(''),undefined);
 assert.equal((await pickSession(sessions,{query:'build',output})).title,'Flaky build investigation');
 assert.equal(await pickSession(sessions,{query:'nothing like this',output}),undefined);
 assert.equal((await pickSession(sessions,{query:'dddddddd-0000-4000-8000-000000000004',output})).providerId,'dddddddd-0000-4000-8000-000000000004');
});
test('Terminal takes over a phone conversation whose Claude process is idle',async t=>{
 const dir=fixture(t);const store=new Store(dir);const p=new Providers(store);
 const uuid='eeeeeeee-0000-4000-8000-000000000005',id='claude:'+uuid;
 store.save({id,provider:'claude',providerId:uuid,cwd:dir,title:'Phone work',status:'idle',control:'managed',started:true});
 const child=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});p.claude.set(id,child);child.on('exit',()=>p.claude.delete(id));
 p.claudeActivity=async()=>p.claude.has(id)?[{sessionId:uuid}]:[];p.discoverClaude=async()=>{p.claudeActive=await p.claudeActivity();};
 const create=ClaudeTerminal.create;let launched;ClaudeTerminal.create=options=>{launched=options;return {ended:false,close:async()=>{}};};
 t.after(()=>{ClaudeTerminal.create=create;try{process.kill(-child.pid,'SIGKILL');}catch{}store.close();});
 store.save({...store.session(id),status:'running'});
 await assert.rejects(p.startTerminal({command:'/bin/echo',args:['--resume',uuid],cwd:dir}),/still replying/);
 assert.equal(child.exitCode,null);
 store.save({...store.session(id),status:'idle'});
 assert.deepEqual(await p.startTerminal({command:'/bin/echo',args:['--resume',uuid],cwd:dir}),{id});
 assert.equal(p.claude.has(id),false);assert.ok(launched.args.includes(uuid));assert.equal(store.session(id).control,'terminal');
});
