import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createServer} from '../src/server.mjs';
import {installTerminal,refreshTerminal} from '../src/terminal-setup.mjs';
import {Providers} from '../src/providers.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ar-terminal-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('shell integration preserves startup config, is idempotent and does not replace the native binary',t=>{
 const homeDirectory=fixture(t);writeFileSync(join(homeDirectory,'.zshrc'),'# Existing configuration\nexport EXAMPLE=1\n');
 const result=installTerminal({homeDirectory,node:'/Example/Agent Remote/node',launcher:"/Example/Agent's Remote/terminal.mjs"});
 const first=readFileSync(join(homeDirectory,'.zshrc'),'utf8');assert.ok(first.startsWith('# Existing configuration\nexport EXAMPLE=1\n'));assert.equal(first.split('# Agent Remote terminal access').length,2);
 installTerminal({homeDirectory,node:'/Example/node',launcher:'/Example/terminal.mjs'});assert.equal(readFileSync(join(homeDirectory,'.zshrc'),'utf8'),first);
 const script=readFileSync(result.integration,'utf8');assert.ok(script.includes('[[ -t 0 && -t 1'));assert.ok(script.includes('builtin whence -p codex'));assert.ok(script.includes('command codex "$@"'));assert.equal(statSync(result.integration).mode&0o777,0o600);assert.ok(script.includes('function claude'));assert.ok(script.includes('command claude'));
});
test('only a local Mac credential can obtain the terminal server connection',async t=>{
 const store=new Store(fixture(t));t.after(()=>store.close());let starts=0;
 const providers={codex:async()=>{starts++;},codexHost:{endpoint:'ws://127.0.0.1:1234',token:'fixture-only'}};
 const {server}=createServer({store,providers});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/terminal/codex';
 const request=token=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
 assert.equal((await request(store.createDevice('Phone').token)).status,403);assert.equal(starts,0);
 const local=store.desktopToken();const response=await request(local);assert.equal(response.status,200);assert.equal((await response.json()).token,'fixture-only');assert.equal(starts,1);
 assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+local,Origin:'http://localhost'}})).status,403);
});
test('opening a terminal-owned live thread subscribes without changing its configuration',async t=>{
 const store=new Store(fixture(t));t.after(()=>store.close());const p=new Providers(store);const calls=[];
 store.save({id:'codex:t',provider:'codex',providerId:'t',status:'idle'});
 p.codex=async()=>({call:async(method,params)=>{calls.push([method,params]);return {thread:{id:'t',status:{type:'idle'},turns:[]}};}});
 await p.history('codex:t');assert.deepEqual(calls.find(([m])=>m==='thread/resume'),['thread/resume',{threadId:'t',excludeTurns:true}]);assert.equal(p.loaded.has('t'),true);
});

test('phone turns inherit an already-running terminal session permissions and model',async t=>{
 const store=new Store(fixture(t));t.after(()=>store.close());const p=new Providers(store);const calls=[];
 store.save({id:'codex:t',provider:'codex',providerId:'t',status:'idle',external:false,control:'managed'});p.loaded.add('t');
 p.codex=async()=>({call:async(method,params)=>{calls.push([method,params]);return {};}});
 await p.send('codex:t',{text:'Continue',requestId:'phone'});
 const start=calls.find(([m])=>m==='turn/start')[1];assert.equal(start.input[0].text,'Continue');
 for(const key of ['approvalPolicy','sandboxPolicy','model','cwd'])assert.equal(Object.hasOwn(start,key),false);
 assert.equal(calls.find(([m])=>m==='thread/inject_items')[1].items[0].role,'developer');
});

test('unhandled terminal interactions are not rejected by the phone observer',t=>{
 const store=new Store(fixture(t));t.after(()=>store.close());store.save({id:'codex:t',provider:'codex',status:'running'});const p=new Providers(store);let responses=0;
 p.codexEvent({send:()=>responses++},{id:123,method:'item/commandExecution/requestApproval',params:{threadId:'t'}});
 assert.equal(responses,0);assert.equal(store.messages('codex:t').at(-1).kind,'attention');
});
test('an enabled integration is refreshed with new commands without touching startup config',t=>{
 const homeDirectory=fixture(t);
 assert.equal(refreshTerminal({homeDirectory,node:'/N/node',launcher:'/L/terminal.mjs'}),false);
 const {integration}=installTerminal({homeDirectory,node:'/Old/node',launcher:'/Old/terminal.mjs'});const zshrc=readFileSync(join(homeDirectory,'.zshrc'),'utf8');
 writeFileSync(integration,'# older version without pickup\n');
 assert.equal(refreshTerminal({homeDirectory,node:'/N/node',launcher:'/L/terminal.mjs'}),true);
 const script=readFileSync(integration,'utf8');assert.ok(script.includes('function pickup'));assert.ok(script.includes("'/L/terminal.mjs' pickup"));
 assert.equal(refreshTerminal({homeDirectory,node:'/N/node',launcher:'/L/terminal.mjs'}),false);assert.equal(readFileSync(join(homeDirectory,'.zshrc'),'utf8'),zshrc);
});
