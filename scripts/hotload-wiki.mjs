// Apply only the reviewed wiki implementation without restarting provider sessions.
// The live database must already contain the reviewed wiki tables.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
const [pidText,directory]=process.argv.slice(2);const pid=Number(pidText);const root=resolve(directory||'');
assert.ok(Number.isSafeInteger(pid)&&pid>1&&directory);
const command=execFileSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8'}).trim();
assert.ok(command.includes('/node ')&&command.endsWith(join(root,'server.mjs')),'Unexpected service process');
try{await fetch('http://127.0.0.1:9229/json/list');throw Error('Inspector already in use');}catch(e){if(e.message==='Inspector already in use')throw e;}
const version=Date.now();const knowledgeURL=pathToFileURL(join(root,'knowledge.mjs')).href;const freshURL=knowledgeURL+'?wiki='+version;
const workerPath=join(root,'memory-worker-reload.mjs');
writeFileSync(workerPath,readFileSync(join(root,'memory-worker.mjs'),'utf8').replace("'./knowledge.mjs'",JSON.stringify(freshURL)),{mode:0o600});
process.kill(pid,'SIGUSR1');let endpoint;
for(let i=0;i<60;i++){try{endpoint=(await(await fetch('http://127.0.0.1:9229/json/list')).json())[0]?.webSocketDebuggerUrl;if(endpoint)break;}catch{}await new Promise(r=>setTimeout(r,50));}
assert.ok(endpoint,'Inspector unavailable');
const ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
let seq=0;const pending=new Map();ws.on('message',data=>{const m=JSON.parse(data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
async function evaluate(code){
 const expression=`process.getBuiltinModule('vm').runInThisContext(${JSON.stringify(code)},{importModuleDynamically:process.getBuiltinModule('vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})`;
 const id=++seq;const response=new Promise((r,j)=>{const timeout=setTimeout(()=>j(Error('Inspector evaluation timed out')),20000);pending.set(id,m=>{clearTimeout(timeout);r(m);});});
 ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
 const m=await response;if(m.error||m.result?.exceptionDetails)throw Error('Wiki reload failed: '+JSON.stringify(m.error||m.result.exceptionDetails));return m.result.result.value;
}
try{
 assert.equal(await evaluate('process.pid'),pid);
 assert.equal(await evaluate(`(async()=>{
  const old=await import(${JSON.stringify(knowledgeURL)});const fresh=await import(${JSON.stringify(freshURL)});
  for(const key of Object.getOwnPropertyNames(fresh.Knowledge.prototype))if(key!=='constructor')Object.defineProperty(old.Knowledge.prototype,key,Object.getOwnPropertyDescriptor(fresh.Knowledge.prototype,key));
  const oldWorker=await import(${JSON.stringify(pathToFileURL(join(root,'memory-worker.mjs')).href)});
  const freshWorker=await import(${JSON.stringify(pathToFileURL(workerPath).href)});
  oldWorker.MemoryWorker.prototype.learnPage=async function(...args){this.synthesize=freshWorker.synthesizeKnowledge;return freshWorker.MemoryWorker.prototype.learnPage.apply(this,args);};
  // Preserve the existing authenticated handler, adding revision context for its older route.
  const {AsyncLocalStorage}=await import('node:async_hooks');const context=new AsyncLocalStorage();
  const server=process._getActiveHandles().find(h=>h.constructor.name==='Server'&&h.address()?.address==='127.0.0.1');
  if(!server)throw Error('Loopback server unavailable');
  const handlers=server.listeners('request');if(handlers.length!==1)throw Error('Unexpected request handlers');
  server.removeListener('request',handlers[0]);server.on('request',(req,res)=>context.run(req.url,()=>handlers[0].call(server,req,res)));
  const read=fresh.Knowledge.prototype.read;old.Knowledge.prototype.read=function(id,options={}){const url=context.getStore();if(url){const revision=new URL(url,'http://localhost').searchParams.get('revision');if(revision!==null)options={...options,revision};}return read.call(this,id,options);};
  return true;
 })()`),true);
 console.log('Wiki methods and editor updated without restarting the service.');
}finally{
 try{await evaluate("import('node:inspector').then(m=>{setTimeout(()=>m.close(),100);return true;})");}finally{ws.close();rmSync(workerPath,{force:true});}
 let closed=false;for(let i=0;i<60;i++){try{await fetch('http://127.0.0.1:9229/json/list');}catch{closed=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.ok(closed,'Inspector did not close');console.log('Temporary inspector closed.');
}
