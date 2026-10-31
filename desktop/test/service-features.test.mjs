import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,chmodSync,realpathSync} from 'node:fs';import {tmpdir,homedir} from 'node:os';import {join} from 'node:path';import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';import {createServer} from '../src/server.mjs';
import {AgentReadiness,resolveAgent} from '../src/agents.mjs';import {autoTitle,recentFolders} from '../src/session-meta.mjs';
import {KeepAwake,keepAwakeEnabled,setKeepAwake} from '../src/keep-awake.mjs';import {codexTitle,claudeSessionTitle} from '../src/providers.mjs';

function fixture(t,{agents={list:async()=>({agents:[]})},keepAwake}={}){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ar-features-'))),store=new Store(dir);
 const providers={claudeAuth:{summary:()=>({state:'ok',expiresAt:null,login:null})},discover:async()=>({sessions:store.sessions(),warnings:[]}),history:async()=>{},send:async()=>{},status:(id,status)=>store.save({...store.session(id),status})};
 const awake=typeof keepAwake==='function'?keepAwake(store):keepAwake;
 const {server,notifications}=createServer({store,providers,agents,keepAwake:awake});
 const token=store.desktopToken(),phone=store.createDevice('phone').token;
 t.after(async()=>{awake?.close();notifications.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(path,{method='GET',body,auth=token}={})=>{
  if(!server.listening)await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,body:await res.json()};
 };
 return {dir,store,call,phone,awake};
}

test('GET /agents reports installed CLIs and sign-in, cached for 30 seconds',async t=>{
 let now=0,runs=0,claudeState='ok';const resolved={claude:'/bin/claude',codex:'/bin/codex'};
 const agents=new AgentReadiness({resolve:name=>resolved[name]||null,exec:async(file,args)=>{runs++;assert.deepEqual([file,args],['/bin/codex',['login','status']]);return runs===1?0:1;},claudeAuth:()=>({summary:()=>({state:claudeState})}),now:()=>now});
 const f=fixture(t,{agents});
 for(const auth of [null,f.phone]){const r=await f.call('/agents',{auth});assert.equal(r.status,auth?200:401);}
 const first=await f.call('/agents');
 assert.deepEqual(first.body,{agents:[{id:'claude',name:'Claude',installed:true,signedIn:true},{id:'codex',name:'Codex',installed:true,signedIn:true}]});
 claudeState='expired';assert.deepEqual((await f.call('/agents')).body,first.body,'cached');assert.equal(runs,1);
 now=31_000;const later=(await f.call('/agents')).body.agents;assert.equal(runs,2);
 assert.deepEqual(later.map(a=>a.signedIn),[false,false]);
 const none=new AgentReadiness({resolve:()=>null,exec:async()=>{throw new Error('not run');},claudeAuth:()=>({summary:()=>({state:'ok'})})});
 assert.deepEqual((await none.list()).agents.map(a=>[a.installed,a.signedIn]),[[false,null],[false,null]]);
 const unknown=new AgentReadiness({resolve:name=>'/bin/'+name,exec:async()=>null,claudeAuth:()=>({summary:()=>({state:'unknown'})})});
 assert.deepEqual((await unknown.list()).agents.map(a=>a.signedIn),[null,null]);
});

test('agent CLIs resolve from PATH, the common install folders, or the provider override',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-agents-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const local=join(dir,'.local','bin');mkdirSync(local,{recursive:true});
 const cli=join(local,'codex');writeFileSync(cli,'#!/bin/sh\nexit 0\n');chmodSync(cli,0o755);writeFileSync(join(local,'claude'),'not executable');
 assert.equal(resolveAgent('codex',{PATH:'/nonexistent'},dir),cli);
 assert.notEqual(resolveAgent('claude',{PATH:'/nonexistent'},dir),join(local,'claude'),'a file without execute permission is not a CLI');
 assert.equal(resolveAgent('codex',{PATH:'',AGENT_REMOTE_CODEX:cli},'/nonexistent'),cli);
 assert.equal(resolveAgent('codex',{PATH:'',AGENT_REMOTE_CODEX:join(dir,'missing')},'/nonexistent'),null);
});

test('GET /folders/recent lists distinct existing session folders, newest first, without home',async t=>{
 const f=fixture(t);const home=join(f.dir,'home'),folder=name=>{const p=join(home,name);mkdirSync(p,{recursive:true});return p;};
 const a=folder('a'),b=folder('dev/b'),outside=join(f.dir,'outside');mkdirSync(outside);
 const save=(id,cwd,at,extra={})=>f.store.save({id,provider:'claude',title:id,cwd,status:'idle',updatedAt:at,lastMessageAt:at,...extra});
 save('claude:1',a,100);save('claude:2',b,300);save('claude:3',a+'/',500);save('codex:4',outside,200,{provider:'codex',external:true});
 save('claude:5',home,900);save('claude:6',join(home,'deleted'),800);save('claude:7',b,50);
 assert.deepEqual(recentFolders(f.store,{home}),{home,folders:[{path:a,label:'~/a',lastUsed:500},{path:b,label:'~/dev/b',lastUsed:300},{path:outside,label:outside,lastUsed:200}]});
 for(let i=0;i<20;i++)save('claude:x'+i,folder('many'+i),1000+i);
 const many=recentFolders(f.store,{home}).folders;assert.equal(many.length,12);assert.equal(many[0].label,'~/many19');
 const route=await f.call('/folders/recent',{auth:f.phone});assert.equal(route.status,200);assert.equal(route.body.home,homedir());assert.ok(Array.isArray(route.body.folders));
});

test('the first message names a placeholder chat; later messages and real titles are left alone',async t=>{
 assert.equal(autoTitle('\n  \n  Fix   the\tlogin bug  \nsecond line'),'Fix the login bug');
 const long=autoTitle('Please look through the quarterly revenue dashboard and explain why refunds spiked in March');
 assert.ok(long.length<=60);assert.ok(long.endsWith('…'));assert.equal(long,'Please look through the quarterly revenue dashboard and…');
 assert.equal(autoTitle('x'.repeat(80)),'x'.repeat(59)+'…');assert.equal(autoTitle('   '),'');
 const f=fixture(t);
 f.store.save({id:'claude:new',provider:'claude',title:'New session',titleSource:'placeholder',status:'idle',control:'managed',external:false});
 f.store.save({id:'claude:blank',provider:'claude',title:'',status:'idle',control:'managed',external:false});
 f.store.save({id:'claude:named',provider:'claude',title:'Board prep',titleSource:'custom',status:'idle',control:'managed',external:false});
 const send=async(id,text)=>{const r=await f.call(`/sessions/${encodeURIComponent(id)}/messages`,{method:'POST',body:{requestId:crypto.randomUUID(),text}});assert.equal(r.status,202);f.store.save({...f.store.session(id),status:'idle'});};
 await send('claude:new','Summarise the incident report\nwith details');assert.equal(f.store.session('claude:new').title,'Summarise the incident report');assert.equal(f.store.session('claude:new').titleSource,'prompt');
 await send('claude:new','Now something else');assert.equal(f.store.session('claude:new').title,'Summarise the incident report');
 await send('claude:blank','Blank title chat');assert.equal(f.store.session('claude:blank').title,'Blank title chat');
 await send('claude:named','Should not rename');assert.equal(f.store.session('claude:named').title,'Board prep');
 assert.equal(f.store.session('claude:new').status,'idle');
});

test('POST /sessions/:id/title renames, validates, and the name survives provider refreshes',async t=>{
 const f=fixture(t);
 f.store.save({id:'codex:t',provider:'codex',title:'Codex thread name',status:'idle',external:true,control:'resume'});
 f.store.save({id:'claude:t',provider:'claude',title:'AI title',titleSource:'native-auto',status:'idle',external:true,control:'resume'});
 const renamed=await f.call('/sessions/codex%3At/title',{method:'POST',body:{title:'  Quarterly\n review  '},auth:f.phone});
 assert.equal(renamed.status,200);assert.equal(renamed.body.session.id,'codex:t');assert.equal(renamed.body.session.title,'Quarterly review');assert.ok('unread' in renamed.body.session);
 assert.equal(codexTitle(f.store.session('codex:t'),{name:'Codex renamed it',preview:'x'}),'Quarterly review');
 assert.equal(codexTitle({title:'Old'},{name:'Codex name'}),'Codex name','unrenamed sessions still follow Codex');
 await f.call('/sessions/claude%3At/title',{method:'POST',body:{title:'My Claude chat'}});
 assert.deepEqual(claudeSessionTitle(f.store.session('claude:t'),[{type:'ai-title',aiTitle:'Newer AI title'},{type:'custom-title',customTitle:'CLI name'}]),{title:'My Claude chat',titleSource:'custom'});
 for(const title of ['',' \n ','x'.repeat(121),42,undefined])assert.equal((await f.call('/sessions/codex%3At/title',{method:'POST',body:{title}})).status,400);
 assert.equal((await f.call('/sessions/codex%3At/title',{method:'POST',body:{title:'y'.repeat(120)}})).body.session.title.length,120);
 assert.equal((await f.call('/sessions/missing/title',{method:'POST',body:{title:'x'}})).status,404);
});

test('POST /pairing/invite returns a one-use pairing link for paired devices and the Mac app',async t=>{
 const f=fixture(t);
 for(const auth of [f.phone,null]){
  const r=await f.call('/pairing/invite',{method:'POST',auth});
  if(!auth){assert.equal(r.status,401);continue;}
  assert.equal(r.status,200);assert.match(r.body.uri,/^agentremote:\/\/pair#[A-Za-z0-9_-]+$/);assert.ok(r.body.expires>Date.now()&&r.body.expires<=Date.now()+300_000);
  const invite=JSON.parse(Buffer.from(r.body.uri.split('#')[1],'base64url'));assert.equal(invite.expires,r.body.expires);assert.ok(invite.secret&&invite.channel&&invite.host);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM relay_invites WHERE id=? AND consumed=0').get(invite.channel).n,1);
 }
 assert.equal((await f.call('/pairing/invite',{method:'POST'})).status,200);
 assert.equal((await f.call('/pairing/invite')).status,404);
});

test('keep awake holds caffeinate only while a managed session works, and follows the setting',async t=>{
 const spawned=[];const hold=pid=>{const child=new EventEmitter();child.pid=pid;child.kill=()=>{child.killed=true;child.exitCode=0;child.emit('exit');};spawned.push(child);return child;};
 const f=fixture(t,{keepAwake:store=>new KeepAwake(store,{spawnHold:hold,pid:4242})}),awake=f.awake;
 assert.equal(keepAwakeEnabled(f.store),true,'on by default');
 f.store.save({id:'claude:ext',provider:'claude',status:'running',external:true});assert.equal(awake.update(),false,'external sessions do not hold the Mac awake');
 f.store.save({id:'claude:m',provider:'claude',status:'running',external:false});assert.equal(awake.update(),true);assert.equal(spawned.length,1);assert.equal(spawned[0].pid,4242);
 awake.update();assert.equal(spawned.length,1,'one hold at a time');
 f.store.save({...f.store.session('claude:m'),status:'waiting'});awake.update();assert.equal(spawned.length,1);
 f.store.save({...f.store.session('claude:m'),status:'idle'});assert.equal(awake.update(),false);assert.equal(spawned[0].killed,true);
 f.store.save({...f.store.session('claude:m'),status:'submitting'});awake.update();assert.equal(spawned.length,2);
 setKeepAwake(f.store,false);awake.update();assert.equal(spawned[1].killed,true);
 assert.throws(()=>setKeepAwake(f.store,'yes'),/enabled/);
 assert.deepEqual((await f.call('/settings/keep-awake',{auth:f.phone})).body,{enabled:false});
 setKeepAwake(f.store,true);f.store.save({...f.store.session('claude:m'),status:'running'});awake.update();assert.equal(spawned.length,3);
 assert.deepEqual((await f.call('/settings/keep-awake',{method:'POST',body:{enabled:false}})).body,{enabled:false});assert.equal(spawned[2].killed,true,'turning it off releases the hold at once');
 assert.deepEqual((await f.call('/settings/keep-awake')).body,{enabled:false});
 assert.equal((await f.call('/settings/keep-awake',{method:'POST',body:{enabled:'off'}})).status,400);
 setKeepAwake(f.store,true);awake.update();assert.equal(spawned.length,4);
 awake.close();assert.equal(spawned[3].killed,true,'released on exit');
});
