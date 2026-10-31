import {fixtureDirectory} from './fixture-directory.mjs';
import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';import {Store} from '../desktop/src/store.mjs';import {createServer} from '../desktop/src/server.mjs';import {writeDesktopStatus} from '../desktop/src/desktop-status.mjs';import {installTerminal} from '../desktop/src/terminal-setup.mjs';
process.env.AGENT_REMOTE_PTY=resolve('build/TerminalHost');
const dir=fixtureDirectory('ar-claude-launcher-');const store=new Store(join(dir,'state'));const {server,providers}=createServer({store});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const timer=setInterval(()=>writeDesktopStatus(store,{port:server.address().port,relay:'test'}),2000);writeDesktopStatus(store,{port:server.address().port,relay:'test'});
const phone=store.createDevice('Fixture phone').token,base='http://127.0.0.1:'+server.address().port;
async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+phone,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,result.error);return result;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";const setup=installTerminal({homeDirectory:dir});let id,terminal,output='';
try{
 terminal=spawn('python3',['-u',resolve('scripts/terminal-fixture.py'),JSON.stringify(['/bin/zsh','-ic','source '+quote(setup.integration)+'; claude --dangerously-skip-permissions'])],{cwd:dir,stdio:['pipe','pipe','pipe'],env:{...process.env,AGENT_REMOTE_STATE:store.directory,NODE_NO_WARNINGS:'1'}});
 terminal.stdout.on('data',b=>{output=(output+b.toString()).slice(-20000);});terminal.stderr.on('data',()=>{});
 for(let n=0;n<150;n++){id=[...providers.terminals.keys()][0];if(id)break;await sleep(200);}assert.ok(id,'launcher did not start: '+output.slice(-1500));
 const host=providers.terminals.get(id),pid=host.child.pid,path='/sessions/'+encodeURIComponent(id),plain=()=>{const b=host.screen.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n');};
 async function wait(check,label){for(let n=0;n<500;n++){await sleep(200);if(check(plain()))return;}throw Error(label+'\n'+plain().slice(-3000));}
 await wait(s=>s.includes('trust')||s.includes('Claude Code'),'startup');await sleep(1000);if(/trust this folder/i.test(plain())){terminal.stdin.write('\x1b[B');await sleep(100);terminal.stdin.write('\r');}await sleep(2000);
 const type=async(text)=>{terminal.stdin.write('\x1b[200~'+text+'\x1b[201~');await sleep(200);terminal.stdin.write('\r');};
 await type('Remember the code word ORCHARD. Reply exactly FIRST_OK. Do not use tools.');await wait(s=>(s.match(/FIRST_OK/g)||[]).length>=2,'first turn');console.log('Normal claude command completed first turn');
 const detail=await api(path);assert.equal(detail.session.control,'terminal');assert.equal(detail.session.terminal,true);assert.ok(detail.messages.some(m=>m.role==='assistant'&&m.text.includes('FIRST_OK')));
 const frame=await api(path+'/terminal');assert.equal(frame.sharedInput,true);
 const prompt={prompt:'What is the code word? Reply exactly PHONE_ORCHARD if you remember. Do not use tools.',inputRevision:frame.inputRevision,requestId:randomUUID()};
 await api(path+'/terminal/input',prompt);await api(path+'/terminal/input',prompt);
 await wait(s=>(s.match(/PHONE_ORCHARD/g)||[]).length>=2,'phone turn');console.log('Authenticated phone API used same live session');
 // Desktop continues with ordinary typing, without any control handoff.
 await sleep(500);assert.ok(!output.includes('Phone has control.'));
 await type('What is the code word? Reply exactly DESKTOP_ORCHARD if you remember. Do not use tools.');await wait(s=>(s.match(/DESKTOP_ORCHARD/g)||[]).length>=2,'desktop turn');assert.equal(host.child.pid,pid);await sleep(500);assert.ok(output.includes('DESKTOP_ORCHARD'));
 assert.ok(!output.includes('Background memory learning is automatic'),'memory instructions displayed');
 // Exercise a real native Claude multiple-choice question through terminal keys.
 await type('Use the native AskUserQuestion tool now. Ask which drink I prefer, with exactly two options Tea and Coffee. After I choose, reply DRINK_CONFIRMED with my choice. Do not use any other tool.');
 await wait(s=>s.includes('Tea')&&s.includes('Coffee')&&(/Enter to|Select|select|Chat about/.test(s)),'native question');
 terminal.stdin.write('\r');await sleep(500);terminal.stdin.write('\r');
 await wait(s=>(s.match(/DRINK_CONFIRMED/g)||[]).length>=2,'native question continuation');console.log('Native multiple-choice question answered through terminal Enter');
 // Exercise native slash-command dispatch without sending it as model chat.
 await type('/compact Keep the code word ORCHARD.');await wait(s=>/compact|Compacting/.test(s),'compact dispatch');
 console.log('Same desktop continued without taking control; hidden memory instructions and slash-command input passed');
 await api(path+'/end',{});assert.ok(host.ended);await api(path+'/delete',{});assert.equal(store.session(id),undefined);assert.equal(providers.terminals.has(id),false);id=null;
 console.log('Phone end/delete passed; original terminal client detached without a fork');
}finally{clearInterval(timer);terminal?.kill();if(id)await providers.remove(id).catch(()=>{});await providers.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
