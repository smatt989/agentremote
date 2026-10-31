// Local maintenance only: apply a reviewed module update without restarting a
// service-owned terminal. The inspector is closed before this command returns.
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import assert from 'node:assert/strict';
const [pidText,mode,modulePath]=process.argv.slice(2),pid=Number(pidText);
assert.ok(Number.isSafeInteger(pid)&&pid>1&&['providers','input','fixture','shared-service','shared-launcher','terminal-size'].includes(mode));
const command=execFileSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8'}).trim();
assert.ok(command.includes('node')&&(mode==='fixture'?command.includes('inspector-fixture.mjs'):command.includes('/Applications/Agent Remote.app/Contents/Resources/')),'Unexpected process');
try{await fetch('http://127.0.0.1:9229/json/list');throw Error('Inspector port already in use');}catch(e){if(e.message==='Inspector port already in use')throw e;}
process.kill(pid,'SIGUSR1');let endpoint;
for(let n=0;n<50;n++){try{const rows=await(await fetch('http://127.0.0.1:9229/json/list')).json();endpoint=rows[0]?.webSocketDebuggerUrl;if(endpoint)break;}catch{}await new Promise(r=>setTimeout(r,50));}
assert.ok(endpoint,'Inspector did not start');const ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
let next=0;const pending=new Map();ws.on('message',data=>{const m=JSON.parse(data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
async function evaluate(expression){expression=`process.getBuiltinModule('vm').runInThisContext(${JSON.stringify(expression)},{importModuleDynamically:process.getBuiltinModule('vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})`;const id=++next;const wait=new Promise(r=>pending.set(id,r));ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));const timeout=setTimeout(()=>ws.terminate(),10000);try{const m=await wait;if(m.error||m.result?.exceptionDetails)throw Error('Patch evaluation failed: '+JSON.stringify(m.error||m.result.exceptionDetails));return m.result.result.value;}finally{clearTimeout(timeout);}}
async function inspectRequest(method,params){const id=++next;const wait=new Promise(r=>pending.set(id,r));ws.send(JSON.stringify({id,method,params}));const reply=await wait;if(reply.error)throw Error('Unable to inspect launcher');return reply.result;}
async function findTerminalPath(fn,depth=0){
 if(depth>4)return;
 const props=await inspectRequest('Runtime.getProperties',{objectId:fn,ownProperties:true});const scopes=props.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;if(!scopes)return;
 const list=await inspectRequest('Runtime.getProperties',{objectId:scopes,ownProperties:true});
 for(const scope of list.result||[]){if(!/^\d+$/.test(scope.name)||!scope.value?.objectId)continue;const values=await inspectRequest('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});
  const path=values.result?.find(p=>p.name==='path')?.value?.value;if(typeof path==='string'&&/^\/sessions\/claude(?:%3A|:)[0-9a-f-]{36}\/terminal$/.test(path))return path;
  const listener=values.result?.find(p=>p.name==='listener')?.value;if(listener?.type==='function'){const found=await findTerminalPath(listener.objectId,depth+1);if(found)return found;}
 }
}
try{
 assert.equal(await evaluate('process.pid'),pid);
 const url=pathToFileURL(resolve(modulePath)).href;
 let launcherSession;
 if(['shared-launcher','terminal-size'].includes(mode)){
  const result=await inspectRequest('Runtime.evaluate',{expression:"process.stdin.listeners('data')[0]"});const path=await findTerminalPath(result.result.objectId);assert.ok(path,'Could not identify the launcher session safely');launcherSession=decodeURIComponent(path.split('/')[2]);
 }

 const expression=mode==='shared-service'?`(async()=>{
  for(const [file,name] of [['providers.mjs','Providers'],['store.mjs','Store'],['claude-terminal.mjs','ClaudeTerminal']]){
   const path=new URL(file,${JSON.stringify(url)}).href;const old=await import(path);const fresh=await import(path+'?dimensions=068b');
   if(typeof fresh[name].create==='function')old[name].create=fresh[name].create;
   for(const key of Object.getOwnPropertyNames(fresh[name].prototype))if(key!=='constructor')Object.defineProperty(old[name].prototype,key,Object.getOwnPropertyDescriptor(fresh[name].prototype,key));
  }return true;
 })()`:
 mode==='terminal-size'?`(async()=>{
  if(globalThis.agentRemoteTerminalSize)return true;
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');const root=path.join(process.getBuiltinModule('os').homedir(),'Library/Application Support/AgentRemote');
  const status=JSON.parse(fs.readFileSync(path.join(root,'desktop-status.json'),'utf8'));const token=fs.readFileSync(path.join(root,'desktop-token'),'utf8').trim();
  const endpoint='http://127.0.0.1:'+status.port+'/sessions/'+encodeURIComponent(${JSON.stringify(launcherSession||'')})+'/terminal/input';
  let pending=Promise.resolve();const resize=()=>pending=pending.then(async()=>{
   const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({resize:{cols:process.stdout.columns,rows:process.stdout.rows}})});
   if(!response.ok)throw Error('Resize rejected');
  });
  await resize();process.stdout.on('resize',()=>{resize().catch(()=>{});});globalThis.agentRemoteTerminalSize=true;return true;
 })()`:
 mode==='shared-launcher'?`(async()=>{
  if(globalThis.agentRemoteSharedInput)return true;
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');const root=path.join(process.getBuiltinModule('os').homedir(),'Library/Application Support/AgentRemote');
  const status=JSON.parse(fs.readFileSync(path.join(root,'desktop-status.json'),'utf8'));const token=fs.readFileSync(path.join(root,'desktop-token'),'utf8').trim();
  const base='http://127.0.0.1:'+status.port;const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const id=${JSON.stringify(launcherSession||'')};if(!/^claude:[0-9a-f-]{36}$/.test(id))throw Error('Explicit session ID required');const endpoint=base+'/sessions/'+encodeURIComponent(id)+'/terminal';
  const response=await fetch(endpoint,{headers});if(!response.ok)throw Error('Terminal not found');const frame=await response.json();if(frame.ended||!frame.sharedInput)throw Error('Terminal is not ready for shared input');
  const {filterTerminalInput}=await import(${JSON.stringify(url+'?dimensions=068b')});
  process.stdin.removeAllListeners('data');let inputs=Promise.resolve();
  filterTerminalInput(process.stdin,data=>{if(data.includes(29))return;inputs=inputs.then(async()=>{const r=await fetch(endpoint+'/input',{method:'POST',headers,body:JSON.stringify({requestId:process.getBuiltinModule('crypto').randomUUID(),data:data.toString('base64')}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Terminal input was not accepted.');}).catch(e=>process.stderr.write('\\r\\n'+e.message+'\\r\\n'));});
  globalThis.agentRemoteSharedInput=true;return true;
 })()`:
 mode==='providers'?`(async()=>{const old=await import(${JSON.stringify(url)});const fresh=await import(${JSON.stringify(url+'?history-fix=061')});old.Providers.prototype.history=fresh.Providers.prototype.history;return true;})()`:
 mode==='input'?`(async()=>{const {filterTerminalInput}=await import(${JSON.stringify(url)});if(globalThis.agentRemoteInputFixed)return true;const listeners=process.stdin.listeners('data');if(listeners.length!==1)throw Error('Unexpected input listeners');process.stdin.removeListener('data',listeners[0]);let warned=false;const write=process.stderr.write;process.stderr.write=function(chunk,...args){if(String(chunk)==='\\r\\nPhone has control. Press Ctrl-] to type here.\\r\\n'){if(warned){const cb=args.find(a=>typeof a==='function');if(cb)queueMicrotask(cb);return true;}warned=true;}return write.call(this,chunk,...args);};filterTerminalInput(process.stdin,data=>{if(data.includes(29))warned=false;listeners[0](data);});globalThis.agentRemoteInputFixed=true;return true;})()`:
 `(async()=>{const old=await import(${JSON.stringify(url)});const fresh=await import(${JSON.stringify(url+'?history-fix=061')});old.Providers.prototype.history=fresh.Providers.prototype.history;return globalThis.fixture.history()===2;})()`;
 assert.equal(await evaluate(expression),true);
 console.log(mode+': reviewed update applied to PID '+pid);
}finally{
 await evaluate("import('node:inspector').then(m=>{setTimeout(()=>m.close(),100);return true;})");ws.close();await new Promise(r=>ws.once('close',r));
 let closed=false;
 for(let n=0;n<50;n++){try{await fetch('http://127.0.0.1:9229/json/list');}catch{closed=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.ok(closed,'Inspector did not close');console.log('Temporary local inspector closed.');
}
