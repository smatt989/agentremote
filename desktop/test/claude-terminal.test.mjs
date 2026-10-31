import test from 'node:test';import assert from 'node:assert/strict';import {ClaudeTerminal,claudeLaunch} from '../src/claude-terminal.mjs';import {Store} from '../src/store.mjs';import {createServer} from '../src/server.mjs';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('shared Claude launch retains arguments and requires explicit resume identity',()=>{
 const args=['--model','haiku','hello'];const result=claudeLaunch(args);assert.deepEqual(result.args.slice(2),args);assert.equal(result.args[1],result.uuid);
 assert.deepEqual(claudeLaunch(['--resume',result.uuid]).args,['--resume',result.uuid]);
 for(const args of [['-c'],['--resume'],['--resume','named'],['--fork-session']])assert.throws(()=>claudeLaunch(args));
});
test('both devices can type without handoff; repeated requests remain idempotent',()=>{
 const t=Object.create(ClaudeTerminal.prototype);Object.assign(t,{owner:'desktop',generation:1,requests:new Map(),ended:false});const writes=[];t.child={stdin:{write:b=>writes.push(String(b))}};
 const input={owner:'desktop',generation:1,requestId:'1',data:Buffer.from('hello').toString('base64')};t.input(input);t.input(input);assert.deepEqual(writes,['hello']);
 assert.throws(()=>t.input({...input,data:'eA=='}),/already used/);
 t.control('phone');t.input({...input,owner:'phone',requestId:'2'});t.input({...input,requestId:'3'});assert.equal(writes.length,3);
});
test('phone prompt validates desktop draft and revision and keeps paste/enter together',async()=>{
 const t=Object.create(ClaudeTerminal.prototype);Object.assign(t,{owner:'desktop',generation:1,requests:new Map(),ended:false});const writes=[];t.child={stdin:{write:b=>writes.push(String(b))}};
 let line='❯ ';t.screen={rows:1,buffer:{active:{baseY:0,cursorY:0,getLine:()=>({translateToString:()=>line})}}};
 const prompt={owner:'phone',requestId:'p',prompt:'Hello',inputRevision:0};
 line='❯ draft';assert.throws(()=>t.input(prompt),/draft/);line='❯ ';
 assert.throws(()=>t.input({...prompt,inputRevision:1}),/changed/);
 t.input(prompt);t.input(prompt);t.input({owner:'desktop',requestId:'d',data:Buffer.from('next').toString('base64')});
 assert.deepEqual(writes,['\x1b[200~Hello\x1b[201~']);await new Promise(r=>setTimeout(r,220));
 assert.deepEqual(writes,['\x1b[200~Hello\x1b[201~','\r','next']);assert.equal(t.owner,'desktop');
});
test('phone terminal APIs authenticate, cannot launch processes, and cannot impersonate desktop',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-pty-api-'));const store=new Store(dir);let owner;const terminal={read:async()=>({owner:'desktop',seq:1}),control:o=>{owner=o;return {generation:2};},input:v=>{assert.equal(v.owner,owner);return {ok:true};}};
 store.save({id:'claude:x',provider:'claude',status:'idle'});
 const {server}=createServer({store,providers:{terminals:new Map([['claude:x',terminal]])}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;const phone=store.createDevice('test').token;
 const request=(path,body,token=phone,origin)=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await request('/terminal/claude',{})).status,403);
 assert.equal((await request('/sessions/claude%3Ax/terminal',null,'invalid')).status,401);
 assert.equal((await request('/sessions/claude%3Ax/terminal',null,phone,'http://localhost')).status,403);
 await request('/sessions/claude%3Ax/terminal/control',{});assert.ok(owner.startsWith('phone:'));
 assert.equal((await request('/sessions/claude%3Ax/terminal/input',{owner:'desktop'})).status,200);
});
test('a current viewer long-polls and wakes as soon as output arrives',async()=>{
 const t=Object.create(ClaudeTerminal.prototype);Object.assign(t,{seq:3,chunks:[{seq:3,data:'YQ=='}],waiters:new Set(),ended:false,pending:Promise.resolve(),owner:'desktop',generation:1,screen:{cols:80,rows:24}});
 const started=Date.now();const reading=t.read(3,{wait:5000});
 setTimeout(()=>{t.chunks.push({seq:4,data:'Yg=='});t.seq=4;t.wake();},30);
 const frame=await reading;assert.equal(frame.data,'Yg==');assert.equal(frame.reset,false);assert.ok(Date.now()-started<1000);assert.equal(t.waiters.size,0);
 const idle=Date.now();assert.equal((await t.read(4,{wait:60})).data,'');assert.ok(Date.now()-idle>=50);
});
