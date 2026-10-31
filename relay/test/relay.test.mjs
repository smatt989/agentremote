import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,generateKeyPairSync,createPublicKey,diffieHellman,hkdfSync} from 'node:crypto';
import {WebSocket} from 'ws';
import {Store} from '../../desktop/src/store.mjs';
import {createServer} from '../../desktop/src/server.mjs';
import {RelayState} from '../../desktop/src/relay-state.mjs';
import {DesktopRelay} from '../../desktop/src/relay-client.mjs';
import {createRelay} from '../src/server.mjs';
import {open,seal,validateRelayURL,validatePacket} from '../../shared/secure-channel.mjs';

const header=(host,channel)=>({host,channel,id:randomUUID(),issuedAt:Date.now()});
async function connected(desktop){if(desktop.socket?.readyState===WebSocket.OPEN && desktop.retry===0)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Mac connection timeout')),10_000);const listener=status=>{if(status==='connected'){clearTimeout(timer);desktop.off('status',listener);resolve();}};desktop.on('status',listener);});}
async function fixture(t,options={}){
  const relay=createRelay({requestTimeout:5000,heartbeatInterval:1000,...options});await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));
  const endpoint=`ws://127.0.0.1:${relay.server.address().port}`;
  const dir=mkdtempSync(join(tmpdir(),'agentremote-relay-'));const store=new Store(dir);let sends=0;
  store.save({id:'codex:fixture',provider:'codex',providerId:'fixture',title:'Private project title',cwd:dir,status:'idle',control:'managed',updatedAt:Date.now()});
  const providers={claudeAuth:{summary:()=>({state:'ok',expiresAt:null,login:null}),cancelLogin:()=>({ok:true})},discover:async()=>({sessions:store.sessions(),warnings:[]}),history:async()=>{},status:(id,status)=>store.save({...store.session(id),status}),send:async(id,body)=>{sends++;store.message(id,{id:'reply-'+body.requestId,role:'assistant',kind:'text',text:'PRIVATE_REPLY_'+body.text});}};
  const {server}=createServer({store,providers,agents:{list:async()=>({agents:[{id:'claude',name:'Claude',installed:true,signedIn:true},{id:'codex',name:'Codex',installed:false,signedIn:null}]})}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const state=new RelayState(store);state.configure(endpoint);
  const desktop=new DesktopRelay({store,state,apiURL:`http://127.0.0.1:${server.address().port}`});desktop.start();await connected(desktop);
  const client=new WebSocket(endpoint+'/v1/client');await once(client,'open');
  const wire=[];client.on('message',data=>wire.push(data.toString()));
  t.after(async()=>{client.terminate();desktop.close();await relay.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  function exchange(packet){
    wire.push(JSON.stringify(packet));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{client.off('message',listener);reject(new Error('Response timeout'));},8000);
      const listener=data=>{const value=JSON.parse(data);if((value.packet?.id||value.id)!==packet.id)return;clearTimeout(timer);client.off('message',listener);resolve(value);};
      client.on('message',listener);client.send(JSON.stringify({type:'request',packet}));
    });
  }
  async function pair(){
    const {invite}=state.invite();const ephemeral=generateKeyPairSync('x25519');
    const packet=seal(Buffer.from(invite.secret,'base64'),header(invite.host,invite.channel),{op:'pair',name:'Test phone',publicKey:Buffer.from(ephemeral.publicKey.export({format:'jwk'}).x,'base64url').toString('base64')},'request');
    const frame=await exchange(packet);const response=open(Buffer.from(invite.secret,'base64'),frame.packet,'response');
    assert.equal(response.status,200);
    const paired=JSON.parse(Buffer.from(response.body,'base64'));
    const peer=createPublicKey({key:{kty:'OKP',crv:'X25519',x:Buffer.from(paired.publicKey,'base64').toString('base64url')},format:'jwk'});
    const shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:peer});
    const secret=Buffer.from(hkdfSync('sha256',shared,Buffer.from(invite.secret,'base64'),Buffer.from(`agent-remote/pair/v1/${invite.host}/${paired.deviceId}`),32));
    assert.equal(paired.secret,undefined,'Device encryption keys must never be sent through the relay.');
    return {...paired,secret,invite,packet};
  }
  async function request(device,path,method='GET',body){
    const packet=seal(device.secret,header(state.host,device.deviceId),{method,path,token:device.token,...(body?{body}:{})},'request');
    const frame=await exchange(packet);
    if(frame.type!=='response')return frame;
    return {...open(device.secret,frame.packet,'response'),packet};
  }
  return {relay,store,state,desktop,client,endpoint,pair,request,exchange,wire,sends:()=>sends};
}
test('encrypted QR pairing, conversations and binary artifacts cross the relay without revealing plaintext',async t=>{
  const f=await fixture(t);const device=await f.pair();
  const list=await f.request(device,'/sessions');assert.equal(list.status,200);assert.equal(JSON.parse(Buffer.from(list.body,'base64')).sessions[0].title,'Private project title');
  const body={requestId:randomUUID(),text:'a secret prompt'};
  assert.equal((await f.request(device,'/sessions/codex:fixture/messages','POST',body)).status,202);
  assert.equal((await f.request(device,'/sessions/codex:fixture/messages','POST',body)).status,200);assert.equal(f.sends(),1);
  const image=randomBytes(512_000);
  const uploaded=await f.request(device,'/sessions/codex:fixture/artifacts','POST',{name:'private-chart.png',base64:image.toString('base64')});
  assert.equal(uploaded.status,201);const artifact=JSON.parse(Buffer.from(uploaded.body,'base64'));
  const downloaded=await f.request(device,'/artifacts/'+artifact.id);assert.deepEqual(Buffer.from(downloaded.body,'base64'),image);
  const wire=f.wire.join('\n');for(const privateValue of ['a secret prompt','Private project title','private-chart.png',device.token,device.secret.toString('base64')])assert.equal(wire.includes(privateValue),false);
});
test('a file too big for one relay packet downloads in byte ranges; a whole-file request is refused clearly',async t=>{
  const f=await fixture(t);const device=await f.pair();
  const {artifactDirectory}=await import('../../desktop/src/server.mjs');const {writeFileSync}=await import('node:fs');
  const bytes=randomBytes(30_000_000);const dir=artifactDirectory(f.store,'codex:fixture');writeFileSync(join(dir,'long.mov'),bytes);
  f.store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run('long','codex:fixture','long.mov',join(dir,'long.mov'),'video/quicktime');
  const info=JSON.parse(Buffer.from((await f.request(device,'/artifacts/long/info')).body,'base64'));assert.equal(info.size,bytes.length);
  const parts=[];
  for(let offset=0;offset<info.size;offset+=info.chunk){const r=await f.request(device,`/artifacts/long?offset=${offset}&length=${info.chunk}`);assert.equal(r.status,200);parts.push(Buffer.from(r.body,'base64'));}
  assert.ok(Buffer.concat(parts).equals(bytes));
  const whole=await f.request(device,'/artifacts/long');assert.equal(whole.status,413);assert.match(JSON.parse(Buffer.from(whole.body,'base64')).error,/download it in parts/);
});
test('tampered ciphertext, replay, wrong direction, and revoked devices cannot execute commands',async t=>{
  const f=await fixture(t);const device=await f.pair();
  const packet=seal(device.secret,header(f.state.host,device.deviceId),{method:'GET',path:'/health',token:device.token},'request');
  assert.equal((await f.exchange(packet)).type,'response');
  const replay=await f.exchange(packet);assert.equal(open(device.secret,replay.packet,'response').status,409);
  const changed={...packet,id:randomUUID()};assert.equal((await f.exchange(changed)).reason,'device_not_authorized');
  const wrong=seal(device.secret,header(f.state.host,device.deviceId),{method:'GET',path:'/health',token:device.token},'response');assert.equal((await f.exchange(wrong)).reason,'device_not_authorized');
  f.store.db.prepare('DELETE FROM devices WHERE id=?').run(device.deviceId);
  assert.equal((await f.request(device,'/health')).reason,'device_not_authorized');assert.equal(f.sends(),0);
});
test('pairing codes are single-use and device traffic cannot be opened with the QR bootstrap key',async t=>{
  const f=await fixture(t);const device=await f.pair();
  assert.equal((await f.exchange(device.packet)).reason,'device_not_authorized');
  const value=await f.request(device,'/health');
  assert.throws(()=>open(Buffer.from(device.invite.secret,'base64'),value.packet,'request'));
  const newInvite=f.state.invite().invite;f.store.db.prepare('UPDATE relay_invites SET expires=0').run();assert.equal(f.state.credential(newInvite.channel),undefined);
});
test('host identity cannot be hijacked and desktop reconnect does not restart a session',async t=>{
  const f=await fixture(t);const device=await f.pair();
  const attacker=new WebSocket(f.endpoint+'/v1/host');t.after(()=>attacker.terminate());
  const closed=once(attacker,'close');attacker.on('message',()=>attacker.send(JSON.stringify({type:'register',publicKey:f.state.publicKey.toString('base64'),signature:randomBytes(64).toString('base64')})));
  const [code]=await closed;assert.equal(code,1008);assert.equal(f.relay.stats().hosts,1);
  f.desktop.socket.terminate();await new Promise(resolve=>setTimeout(resolve,50));await connected(f.desktop);
  assert.equal((await f.request(device,'/health')).status,200);assert.equal(f.sends(),0);
});
test('relay refuses browser-origin sockets and reports an offline Mac',async t=>{
  const f=await fixture(t);
  const browser=new WebSocket(f.endpoint+'/v1/client',{origin:'https://example.com'});
  const [error]=await once(browser,'error');assert.match(error.message,/403/);
  const packet=seal(randomBytes(32),header('0'.repeat(64),randomUUID()),{},'request');
  assert.equal((await f.exchange(packet)).reason,'mac_offline');
});
test('endpoint validation refuses downgrade and URL credential injection',()=>{
  for(const url of ['ws://example.com','wss://user:pass@example.com','wss://example.com/path','https://example.com','wss://example.com?token=a'])assert.throws(()=>validateRelayURL(url));
  assert.equal(validateRelayURL('wss://relay.example.com'),'wss://relay.example.com');assert.equal(validateRelayURL('ws://127.0.0.1:8790'),'ws://127.0.0.1:8790');
});
test('envelope validation rejects missing IDs and expired timestamps',()=>{
  const packet=seal(randomBytes(32),header('a'.repeat(64),randomUUID()),{},'request');
  assert.throws(()=>validatePacket({...packet,id:undefined}));
  assert.throws(()=>validatePacket({...packet,channel:undefined}));
  assert.throws(()=>validatePacket({...packet,issuedAt:Date.now()-180_000}));
});

test('Knowledge search and page reads work through the encrypted phone relay',async t=>{
 const f=await fixture(t);const device=await f.pair();
 const session='codex:fixture',text='Revenue excludes refunded orders.';
 f.store.message(session,{id:'fact-source',role:'user',kind:'text',text});
 f.store.memory.apply(f.store.memory.batch(session),{facts:[{topic:'work/example/revenue',text,quote:text,sourceMessage:'fact-source',kind:'fact'}]});
 for(const path of ['/knowledge','/knowledge?q=revenue&offset=0','/knowledge/index']){
  const response=await f.request(device,path);assert.equal(response.status,200);
  assert.ok(JSON.parse(Buffer.from(response.body,'base64')).results.some(p=>p.id==='work/example/revenue~1'));
 }
 const response=await f.request(device,'/knowledge/page?id=work%2Fexample%2Frevenue~1&offset=0');assert.equal(response.status,200);
 assert.match(JSON.parse(Buffer.from(response.body,'base64')).page.markdown,/refunded orders/);
 for(const path of ['/knowledge/admin','/knowledge/page/extra','/knowledge-other','/terminal/codex'])assert.equal((await f.request(device,path)).status,400);
 assert.equal(f.wire.join('\n').includes(text),false);
});

test('completed response timestamps and explicit read receipts travel through the phone relay',async t=>{
 const f=await fixture(t);const device=await f.pair();const id='codex:fixture';
 f.store.message(id,{id:'answer',role:'assistant',kind:'text',text:'Completed answer',completedAt:1234});
 const response=await f.request(device,'/sessions/'+encodeURIComponent(id));const detail=JSON.parse(Buffer.from(response.body,'base64'));
 assert.equal(detail.session.lastCompletedAt,1234);assert.equal(detail.session.unread,true);
 const receipt=await f.request(device,'/sessions/'+encodeURIComponent(id)+'/read','POST',{token:detail.session.latestAssistantToken});
 assert.equal(receipt.status,200);assert.equal(JSON.parse(Buffer.from(receipt.body,'base64')).session.unread,false);
});

test('Claude sign-in routes travel through the phone relay and nothing else under /claude does',async t=>{
 const f=await fixture(t);const device=await f.pair();
 const response=await f.request(device,'/claude/auth');assert.equal(response.status,200);
 assert.ok('state' in JSON.parse(Buffer.from(response.body,'base64')));
 assert.equal((await f.request(device,'/claude/auth/login/cancel','POST',{})).status,200);
 for(const path of ['/claude','/claude/auth/token','/claude/auth/login/code/extra','/claude/authx'])assert.equal((await f.request(device,path)).status,400);
});

test('agents, recent folders, rename, keep awake and pairing links travel through the phone relay; neighbours do not',async t=>{
 const f=await fixture(t);const device=await f.pair();const json=r=>JSON.parse(Buffer.from(r.body,'base64'));
 assert.deepEqual(json(await f.request(device,'/agents')).agents.map(a=>a.id),['claude','codex']);
 const folders=json(await f.request(device,'/folders/recent'));assert.equal(typeof folders.home,'string');assert.ok(Array.isArray(folders.folders));
 const renamed=await f.request(device,'/sessions/codex%3Afixture/title','POST',{title:'Renamed from the phone'});
 assert.equal(renamed.status,200);assert.equal(json(renamed).session.title,'Renamed from the phone');
 assert.deepEqual(json(await f.request(device,'/settings/keep-awake','POST',{enabled:false})),{enabled:false});
 assert.deepEqual(json(await f.request(device,'/settings/keep-awake')),{enabled:false});
 const link=json(await f.request(device,'/pairing/invite','POST'));assert.match(link.uri,/^agentremote:\/\/pair#/);assert.ok(link.expires>Date.now());
 // The link pairs a second device through the relay.
 const invite=JSON.parse(Buffer.from(link.uri.split('#')[1],'base64url'));const ephemeral=generateKeyPairSync('x25519');
 const frame=await f.exchange(seal(Buffer.from(invite.secret,'base64'),header(invite.host,invite.channel),{op:'pair',name:'Laptop',publicKey:Buffer.from(ephemeral.publicKey.export({format:'jwk'}).x,'base64url').toString('base64')},'request'));
 assert.equal(open(Buffer.from(invite.secret,'base64'),frame.packet,'response').status,200);
 for(const path of ['/agentsx','/agents/x','/folders','/folders/recent/x','/pairing','/pairing/invite/x','/settings/keep-awake/x','/settings/keep-awakes'])assert.equal((await f.request(device,path)).status,400,path);
 assert.equal(f.wire.join('\n').includes('Renamed from the phone'),false);
});
test('a Mac over its daily relay allowance gets relay_quota instead of a response',async t=>{
  const f=await fixture(t,{hostDailyBytes:60_000});const device=await f.pair();
  let frame;for(let i=0;i<40;i++){frame=await f.request(device,'/sessions');if(frame.type==='unavailable')break;}
  assert.equal(frame.type,'unavailable');assert.equal(frame.reason,'relay_quota');
  assert.equal(f.relay.stats().pending,0);
});
