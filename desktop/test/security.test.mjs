import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createServer, artifactDirectory, checkArtifactPath, sessionArtifacts } from '../src/server.mjs';

function fixture(t) { const dir=mkdtempSync(join(tmpdir(),'agentremote-')); const store=new Store(dir); t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store; }
test('pairing codes expire, are one-use, and device revocation takes effect',t=>{
  const store=fixture(t); const code=store.pairCode(); const result=store.pair(code,'Phone');
  assert.equal(store.authenticate(result.token),true); assert.throws(()=>store.pair(code,'Imposter'));
  assert.equal(store.authenticate('incorrect'),false);
  store.db.prepare('DELETE FROM devices WHERE id=?').run(result.deviceId); assert.equal(store.authenticate(result.token),false);
  const expired=store.pairCode(); store.db.prepare('UPDATE pairing SET expires=0').run(); assert.throws(()=>store.pair(expired,'Phone'));
});
test('durable request IDs reject changed content and suppress duplicate execution',t=>{
  const store=fixture(t); assert.equal(store.claim('a','codex:x',{text:'hello'}),true);
  assert.equal(store.claim('a','codex:x',{text:'hello'}),false);
  assert.throws(()=>store.claim('a','codex:x',{text:'delete something'}));
  assert.throws(()=>store.claim('a','claude:y',{text:'hello'}));
});
test('history preserves streamed updates and paginates without losing order',t=>{
  const store=fixture(t);
  for(let i=0;i<220;i++) store.message('s',{id:`m${i}`,role:'assistant',kind:'text',text:String(i)});
  store.append('s','m219',' tail');
  const last=store.messages('s'); assert.equal(last.length,200);assert.equal(last.at(-1).text,'219 tail');
  const first=store.messages('s',last[0].seq);assert.equal(first.length,20);assert.equal(first[0].text,'0');
});
test('provider acknowledgements replace the pending user message without duplicating it',t=>{
  const store=fixture(t);store.claim('request','s',{text:'hello'});
  store.message('s',{id:'request',role:'user',kind:'text',text:'hello'});
  store.userAcknowledgement('s',{id:'native-id',role:'user',kind:'text',text:'hello'});
  store.userAcknowledgement('s',{id:'native-id',role:'user',kind:'text',text:'hello'});
  assert.equal(store.messages('s').length,1);assert.equal(store.messages('s')[0].id,'native-id');
});
test('artifact symlinks cannot escape a session directory',t=>{
  const store=fixture(t); const dir=artifactDirectory(store,'codex:a'); const secret=join(store.directory,'secret');writeFileSync(secret,'private');
  const escape=join(dir,'escape.txt');symlinkSync(secret,escape);assert.throws(()=>checkArtifactPath(dir,escape));
  const normal=join(dir,'chart.png');writeFileSync(normal,'chart');assert.equal(checkArtifactPath(dir,normal),realpathSync(normal));
});
test('HTTP endpoints require authentication, reject browser origins, deduplicate messages and support attachments',async t=>{
  const store=fixture(t); let sends=0;
  store.save({id:'claude:test',provider:'claude',control:'managed',status:'idle',updatedAt:0});
  const providers={send:async()=>{sends++;},history:async()=>{},status:()=>{},discover:async()=>({sessions:store.sessions(),warnings:[]})};
  const {server}=createServer({store,providers});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/sessions')).status,401);
  const paired=store.pair(store.pairCode(),'Phone');const headers={'Authorization':`Bearer ${paired.token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/sessions',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const body=JSON.stringify({requestId:'req-1',text:'hello'});
  assert.equal((await fetch(base+'/sessions/claude:test/messages',{method:'POST',headers,body})).status,202);
  assert.equal((await fetch(base+'/sessions/claude:test/messages',{method:'POST',headers,body})).status,200);assert.equal(sends,1);
  const uploaded=await fetch(base+'/sessions/claude:test/artifacts',{method:'POST',headers,body:JSON.stringify({name:'chart.png',base64:Buffer.from('image').toString('base64')})});
  const artifact=await uploaded.json();assert.equal(uploaded.status,201);
  assert.equal(await (await fetch(base+'/artifacts/'+artifact.id,{headers})).text(),'image');
  assert.equal((await fetch(base+'/artifacts/'+artifact.id)).status,401);
});

test('artifacts larger than one relay packet are served in byte ranges, with their size from /info',async t=>{
  const store=fixture(t);const id='claude:big';store.save({id,provider:'claude',control:'managed',status:'idle',updatedAt:0});
  const providers={send:async()=>{},history:async()=>{},status:()=>{},discover:async()=>({sessions:store.sessions(),warnings:[]})};
  const {server}=createServer({store,providers});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const paired=store.pair(store.pairCode(),'Phone');const headers={'Authorization':`Bearer ${paired.token}`};
  const bytes=Buffer.alloc(25_000_123);for(let i=0;i<bytes.length;i+=4096)bytes[i]=i%251;
  const dir=artifactDirectory(store,id);writeFileSync(join(dir,'clip.mp4'),bytes);
  store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run('big',id,'clip.mp4',join(dir,'clip.mp4'),'video/mp4');
  const info=await (await fetch(base+'/artifacts/big/info',{headers})).json();
  assert.equal(info.size,bytes.length);assert.equal(info.mime,'video/mp4');assert.ok(info.chunk>=1_000_000);
  const parts=[];
  for(let offset=0;offset<info.size;offset+=info.chunk){const res=await fetch(`${base}/artifacts/big?offset=${offset}&length=${info.chunk}`,{headers});assert.equal(res.status,200);parts.push(Buffer.from(await res.arrayBuffer()));}
  assert.ok(Buffer.concat(parts).equals(bytes));
  const whole=await fetch(base+'/artifacts/big',{headers});assert.equal(whole.status,200);assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));
  for(const bad of ['offset=-1','offset=1.5','offset=99999999999','offset=0&length=0',`offset=0&length=${info.chunk+1}`])assert.equal((await fetch(`${base}/artifacts/big?${bad}`,{headers})).status,400,bad);
  assert.equal((await fetch(base+'/artifacts/big/info')).status,401);
});
test('model defaults persist and deletion erases local data without rediscovery resurrection',t=>{
  const store=fixture(t);const id='codex:delete';
  store.setModelDefaults({codex:'chosen',claude:'',local:'',localProvider:'ollama'});
  const second=new Store(store.directory);assert.equal(second.modelDefaults().codex,'chosen');second.close();
  const session={id,artifactKey:'artifact-key'};store.save(session);store.message(id,{id:'m',text:'history'});store.claim('r',id,{text:'prompt'});
  const dir=artifactDirectory(store,id);writeFileSync(join(dir,'chart.png'),'image');store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run('a',id,'chart.png',join(dir,'chart.png'),'image/png');
  store.deleteSession(id);assert.equal(existsSync(dir),false);
  store.save(session);store.message(id,{id:'late',text:'late'});assert.equal(store.session(id),undefined);assert.equal(store.messages(id).length,0);
  assert.equal(store.db.prepare('SELECT * FROM requests WHERE session=?').all(id).length,0);assert.equal(store.db.prepare('SELECT * FROM artifacts WHERE session=?').all(id).length,0);
  const reopened=new Store(store.directory);assert.equal(reopened.deleted(id),true);reopened.close();
});
test('settings and permanent delete API require authentication, validate input, and allow deletion retries',async t=>{
  const store=fixture(t);const id='claude:delete';store.save({id,provider:'claude'});
  let removes=0;const providers={remove:async id=>{removes++;store.deleteSession(id);},discover:async()=>({warnings:[]})};
  const {server}=createServer({store,providers});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;const token=store.createDevice('test').token;const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/settings/models')).status,401);
  assert.equal((await fetch(base+'/sessions/'+id+'/delete',{method:'POST'})).status,401);
  const defaults={codex:' chosen ',claude:'',local:'local',localProvider:'ollama'};
  const saved=await fetch(base+'/settings/models',{method:'POST',headers,body:JSON.stringify(defaults)});assert.equal(saved.status,200);assert.equal((await saved.json()).codex,'chosen');
  assert.equal((await (await fetch(base+'/settings/models',{headers})).json()).codex,'chosen');
  assert.equal((await fetch(base+'/settings/models',{method:'POST',headers,body:JSON.stringify({...defaults,codex:42})})).status,400);
  assert.equal((await fetch(base+'/sessions/'+id+'/delete',{method:'POST',headers})).status,200);assert.equal((await fetch(base+'/sessions/'+id+'/delete',{method:'POST',headers})).status,200);assert.equal(removes,1);
  assert.equal((await fetch(base+'/sessions/'+id,{headers})).status,404);
});

test('Mac and phone share one conversation and conflicting inputs cannot launch two turns',async t=>{
  const store=fixture(t);store.save({id:'claude:shared',provider:'claude',status:'idle',control:'managed'});
  let sends=0;const providers={history:async()=>{},discover:async()=>({warnings:[]}),status:()=>{},send:async()=>{sends++;store.save({...store.session('claude:shared'),status:'running'});}};
  const {server}=createServer({store,providers});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;const mac=store.desktopToken();const phone=store.createDevice('Phone').token;
  const headers=token=>({Authorization:`Bearer ${token}`,'Content-Type':'application/json'});
  assert.equal((await fetch(base+'/sessions',{headers:{...headers(mac),Origin:'http://127.0.0.1'}})).status,403);
  const path='/sessions/claude:shared';
  assert.equal((await fetch(base+path+'/messages',{method:'POST',headers:headers(mac),body:JSON.stringify({requestId:'mac',text:'From Mac'})})).status,202);
  // The second input waits in the queue instead of starting a concurrent turn.
  const queued=await fetch(base+path+'/messages',{method:'POST',headers:headers(phone),body:JSON.stringify({requestId:'phone',text:'From phone'})});
  assert.equal(queued.status,202);assert.equal((await queued.json()).queued,true);assert.equal(sends,1);
  store.message('claude:shared',{id:'reply',role:'assistant',kind:'text',text:'Response'});
  const desktopView=await(await fetch(base+path,{headers:headers(mac)})).json();const phoneView=await(await fetch(base+path,{headers:headers(phone)})).json();assert.deepEqual(desktopView,phoneView);
  store.save({...store.session('claude:shared'),status:'idle'});
  for(let i=0;i<100&&sends<2;i++)await new Promise(r=>setTimeout(r,10));assert.equal(sends,2,'delivered when the turn ends');
  assert.equal((await fetch(base+path+'/messages',{method:'POST',headers:headers(phone),body:JSON.stringify({requestId:'phone',text:'From phone'})})).status,200);assert.equal(sends,2);
});
test('session artifacts include subfolder files by relative path, skip hidden files, and type audio',t=>{
  const store=fixture(t);const id='claude:nested';store.save({id,provider:'claude'});const dir=artifactDirectory(store,id);
  mkdirSync(join(dir,'storyboard'));mkdirSync(join(dir,'.hidden'));writeFileSync(join(dir,'still.jpg'),'jpg');writeFileSync(join(dir,'.DS_Store'),'x');
  writeFileSync(join(dir,'storyboard','01.png'),'png');writeFileSync(join(dir,'.hidden','secret.png'),'png');writeFileSync(join(dir,'clip.mp3'),'mp3');
  store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run('old',id,'old.mp3',join(dir,'old.mp3'),'application/octet-stream');writeFileSync(join(dir,'old.mp3'),'mp3');
  const files=sessionArtifacts(store,id);const byName=Object.fromEntries(files.map(f=>[f.name,f.mime]));
  assert.deepEqual(Object.keys(byName).sort(),['clip.mp3','old.mp3','still.jpg','storyboard/01.png']);
  assert.equal(byName['storyboard/01.png'],'image/png');assert.equal(byName['clip.mp3'],'audio/mpeg');assert.equal(byName['old.mp3'],'audio/mpeg');
  assert.equal(sessionArtifacts(store,id).length,4,'rescans do not duplicate rows');
  for(const [file,mime] of [['cut.m4v','video/x-m4v'],['take.mov','video/quicktime'],['vo.aiff','audio/aiff'],['vo.caf','audio/x-caf'],['vo.m4a','audio/mp4'],['vo.wav','audio/wav']])writeFileSync(join(dir,'storyboard',file),'x'),assert.equal(sessionArtifacts(store,id).find(f=>f.name==='storyboard/'+file)?.mime,mime,file);
  const nested=files.find(f=>f.name==='storyboard/01.png');assert.equal(checkArtifactPath(dir,store.db.prepare('SELECT path FROM artifacts WHERE id=?').get(nested.id).path),realpathSync(join(dir,'storyboard','01.png')));
});
