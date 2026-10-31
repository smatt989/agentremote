// Local maintenance only: load the wiki editors (stewards, curators, librarian, verifier, talk pages) into the
// running Agent Remote service without restarting it, since a restart kills every managed Claude child.
// Copies the source modules to a fresh directory so each run imports new code, replaces the Knowledge methods and
// the worker's editorial step, admits /knowledge/talk through the relay, and serves it on the loopback API with
// the service's own device authentication. Re-runnable. Usage: node scripts/hotload-wiki-editors.mjs <pid> [source dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
const pid=Number(process.argv[2]);assert.ok(Number.isSafeInteger(pid)&&pid>1,'Pass the service PID');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const source=resolve(process.argv[3]||join(root,'desktop/src'));
const bundle='/Applications/Agent Remote.app/Contents/Resources/service/desktop/src';
const command=execFileSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8'}).trim();
assert.ok(command.endsWith(join(bundle,'server.mjs')),'Unexpected service process: '+command);
// The snapshot keeps the repo layout (desktop/src beside shared/) so relative imports resolve.
const stamp=Date.now();const base=join(root,'build/wiki-hotload',String(stamp)),snapshot=join(base,'desktop/src');
for(const [from,to] of [[source,snapshot],[join(source,'../../shared'),join(base,'shared')]]){mkdirSync(to,{recursive:true,mode:0o700});for(const name of readdirSync(from).filter(n=>n.endsWith('.mjs')))copyFileSync(join(from,name),join(to,name));}
const B=pathToFileURL(bundle).href+'/',S=pathToFileURL(snapshot).href+'/';
const endpointNow=async()=>{try{return (await (await fetch('http://127.0.0.1:9229/json/list')).json())[0]?.webSocketDebuggerUrl;}catch{}};
assert.equal(await endpointNow(),undefined,'Inspector port already in use');
process.kill(pid,'SIGUSR1');let endpoint;for(let i=0;i<60&&!endpoint;i++){await new Promise(r=>setTimeout(r,50));endpoint=await endpointNow();}
assert.ok(endpoint,'Inspector unavailable');
const ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
let seq=0;const pending=new Map();ws.on('message',data=>{const m=JSON.parse(data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
async function evaluate(code){
  const expression=`process.getBuiltinModule('vm').runInThisContext(${JSON.stringify(code)},{importModuleDynamically:process.getBuiltinModule('vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})`;
  const id=++seq;const wait=new Promise((r,j)=>{const t=setTimeout(()=>j(Error('Inspector evaluation timed out')),60000);pending.set(id,m=>{clearTimeout(t);r(m);});});
  ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  const m=await wait;if(m.error||m.result?.exceptionDetails)throw Error('Hot load failed: '+JSON.stringify(m.error||m.result.exceptionDetails));return m.result.result.value;
}
try{
  assert.equal(await evaluate('process.pid'),pid);
  const result=await evaluate(`(async()=>{
    const live={knowledge:await import(${JSON.stringify(B+'knowledge.mjs')}),worker:await import(${JSON.stringify(B+'memory-worker.mjs')}),relay:await import(${JSON.stringify(B+'relay-client.mjs')})};
    const fresh={knowledge:await import(${JSON.stringify(S+'knowledge.mjs')}),worker:await import(${JSON.stringify(S+'memory-worker.mjs')}),relay:await import(${JSON.stringify(S+'relay-client.mjs')})};
    if(typeof fresh.knowledge.Knowledge.prototype.stewardBatch!=='function')throw Error('Source lacks the wiki editors; nothing changed.');
    // 1. Knowledge methods, including the editorial mixin. rebuild() creates the new tables on first use.
    const names=Object.getOwnPropertyNames(fresh.knowledge.Knowledge.prototype).filter(k=>k!=='constructor');
    for(const key of names)Object.defineProperty(live.knowledge.Knowledge.prototype,key,Object.getOwnPropertyDescriptor(fresh.knowledge.Knowledge.prototype,key));
    const rebuild=fresh.knowledge.Knowledge.prototype.rebuild;
    live.knowledge.Knowledge.prototype.rebuild=function(...args){globalThis.__agentRemoteWiki=this;return rebuild.apply(this,args);};
    // 2. The worker's editorial step uses the new synthesis (role models, verifier tools).
    const learnPage=fresh.worker.MemoryWorker.prototype.learnPage;
    live.worker.MemoryWorker.prototype.learnPage=async function(...args){this.synthesize=fresh.worker.synthesizeKnowledge;if(this.extract===live.worker.extractMemory||this.extract?.hotloaded)this.extract=Object.assign((...a)=>fresh.worker.extractMemory(...a),{hotloaded:true});return learnPage.apply(this,args);};
    // 3. Relay admits /knowledge/talk.
    const handle=fresh.relay.DesktopRelay?.prototype.handle;if(handle&&handle.toString().includes('talk'))live.relay.DesktopRelay.prototype.handle=handle;
    // 4. /knowledge/talk on the loopback API, ahead of the original listener, with the service's own auth.
    const server=process._getActiveHandles().find(h=>h.constructor.name==='Server'&&h.address()?.address==='127.0.0.1'&&h.listenerCount('request')>0);
    if(!server)throw Error('Loopback server unavailable');
    const state=globalThis.__wikiTalkHot||{original:server.listeners('request').at(-1)};
    for(const l of server.listeners('request'))server.removeListener('request',l);
    const fail=(message,status)=>Object.assign(new Error(message),{status});
    server.on('request',(req,res)=>{
      let url;try{url=new URL(req.url,'http://localhost');}catch{return state.original.call(server,req,res);}
      if(url.pathname!=='/knowledge/talk')return state.original.call(server,req,res);
      const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
      (async()=>{
        const wiki=globalThis.__agentRemoteWiki;if(!wiki)throw fail('The wiki is starting. Try again shortly.',503);
        if(req.headers.origin)throw fail('Browser requests are not accepted.',403);
        if(!wiki.store.authenticate(req.headers.authorization?.replace(/^Bearer /,'')))throw fail('Pair this device to connect.',401);
        if(req.method==='GET'){const id=url.searchParams.get('id');if(typeof id!=='string'||!id||id.length>200)throw fail('Invalid request.',400);return reply(200,{talk:wiki.talk(id)});}
        if(req.method!=='POST')throw fail('Not found.',404);
        const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>65536)throw fail('Request too large.',413);chunks.push(c);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail('Invalid JSON.',400);}
        if(typeof body.id!=='string'||body.id.length>200||typeof body.text!=='string'||body.text.length>1400)throw fail('Invalid request.',400);
        try{return reply(200,{ok:true,thread:wiki.comment(body.id,body.text)});}catch(e){throw fail(e.message,400);}
      })().catch(e=>{if(!res.headersSent)reply(e.status||500,{error:e.message});else res.destroy();});
    });
    globalThis.__wikiTalkHot=state;
    return {pid:process.pid,methods:names.length,listeners:server.listenerCount('request'),relayTalk:live.relay.DesktopRelay.prototype.handle.toString().includes('talk')};
  })()`);
  console.log('Hot-loaded wiki editors:',JSON.stringify(result));
}finally{
  try{await evaluate("import('node:inspector').then(m=>{setTimeout(()=>m.close(),100);return true;})");}finally{ws.close();}
  let closed=false;for(let i=0;i<60;i++){try{await fetch('http://127.0.0.1:9229/json/list');}catch{closed=true;break;}await new Promise(r=>setTimeout(r,50));}
  assert.ok(closed,'Inspector did not close');console.log('Temporary inspector closed.');
}
