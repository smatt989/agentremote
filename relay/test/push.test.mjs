import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {generateKeyPairSync,verify,sign,createPublicKey} from 'node:crypto';import {WebSocket} from 'ws';
import {createPusher,createRelay,pushConfig,PUSH_KINDS} from '../src/server.mjs';

const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pem=keys.privateKey.export({type:'pkcs8',format:'pem'});
const token='ab'.repeat(32),good={environment:'production',topic:'com.agentremote.iphone',token,alert:{kind:'reply',title:'Agent Remote',body:'Your agent has replied.'},session:'claude:1',hostId:'0c6f3b1e-1111-4222-8333-944455556666'};
function pusher({status=200,reason='',...options}={}){
  const sent=[];let now=1_000_000;
  const p=createPusher({...pushConfig({APNS_KEY_P8:pem,APNS_KEY_ID:'KEY123',APNS_TEAM_ID:'TEAM123'}),send:async request=>{sent.push(request);return typeof status==='function'?status(request):{status,reason};},now:()=>now,...options});
  return {p,sent,advance:ms=>{now+=ms;}};
}
test('push configuration needs all three Apple values and accepts an escaped PEM',()=>{
  assert.equal(pushConfig({APNS_KEY_ID:'a',APNS_TEAM_ID:'b'}),null);assert.equal(pushConfig({}),null);
  const config=pushConfig({APNS_KEY_P8:pem.replace(/\n/g,'\\n'),APNS_KEY_ID:' KEY ',APNS_TEAM_ID:'TEAM',APNS_TOPICS:'com.a, com.b'});
  assert.deepEqual(config.topics,['com.a','com.b']);assert.equal(config.keyId,'KEY');
  assert.deepEqual(pushConfig({APNS_KEY_P8:pem,APNS_KEY_ID:'K',APNS_TEAM_ID:'T'}).topics,['com.agentremote.iphone']);
  assert.throws(()=>pushConfig({APNS_KEY_P8:'not a key',APNS_KEY_ID:'K',APNS_TEAM_ID:'T'}));
  assert.throws(()=>pushConfig({APNS_KEY_P8:generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),APNS_KEY_ID:'K',APNS_TEAM_ID:'T'}),/EC P-256/);
});
test('push requests are validated strictly before anything reaches Apple',async()=>{
  const {p,sent}=pusher();
  const bad=[{environment:'staging'},{topic:'com.evil.app'},{token:'zz'.repeat(32)},{token:'ab'.repeat(31)},{token:'a'.repeat(201)},{alert:{...good.alert,kind:'marketing'}},{alert:{...good.alert,title:'t'.repeat(65)}},{alert:{...good.alert,body:'b'.repeat(181)}},{alert:{...good.alert,body:''}},{alert:null},{session:'s'.repeat(201)},{session:7},{hostId:'bad host'}];
  for(const change of bad){const result=await p.push('host',{...good,...change});assert.equal(result.ok,false,JSON.stringify(change));assert.equal(result.status,400);}
  assert.equal(sent.length,0);
  assert.deepEqual(await p.push('host',good),{ok:true,status:200,reason:''});
  const [request]=sent;assert.equal(request.environment,'production');assert.equal(request.topic,good.topic);assert.equal(request.token,token);assert.match(request.collapseId,/^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(request.payload),{aps:{alert:{title:'Agent Remote',body:'Your agent has replied.'},sound:'default'},hostId:good.hostId,sessionId:'claude:1',kind:'reply'});
  await p.push('host',{...good,alert:{kind:'question',title:'Agent Remote',body:'Your agent has a question for you.'}});assert.equal(JSON.parse(sent[1].payload).aps['interruption-level'],'time-sensitive');
  await p.push('host',{...good,alert:{kind:'auth',title:'Agent Remote',body:'Claude is signed out on your Mac.'}});assert.equal(JSON.parse(sent[2].payload).sessionId,undefined);
  assert.deepEqual(PUSH_KINDS,['reply','question','test','auth']);
});
test('sealed rich content (e2e) is size-checked, passed through opaque with mutable-content, and never logged',async t=>{
  const {p,sent}=pusher({status:request=>JSON.parse(request.payload).kind==='test'?{status:400,reason:'BadDeviceToken'}:{status:200,reason:''}});
  const e2e=Buffer.alloc(1100,7).toString('base64'),rich={...good,e2e,'mutable-content':1};
  const bad=[{e2e:7,'mutable-content':1},{e2e:'not base64!'.repeat(8),'mutable-content':1},{e2e:'A'.repeat(1504),'mutable-content':1},{e2e:'QUJD','mutable-content':1},{e2e:e2e.slice(1),'mutable-content':1},
    {e2e},{'mutable-content':1},{e2e,'mutable-content':true},{e2e,'mutable-content':1,hostId:undefined},{e2e,'mutable-content':1,session:undefined},{e2e,'mutable-content':1,alert:{kind:'auth',title:'Agent Remote',body:'Claude is signed out on your Mac.'}}];
  for(const change of bad){const result=await p.push('host',{...good,...change});assert.deepEqual(result,{ok:false,status:400,reason:'BadE2E'},JSON.stringify(change).slice(0,80));}
  assert.equal(sent.length,0);
  assert.equal((await p.push('host',rich)).ok,true);
  const payload=JSON.parse(sent[0].payload);
  assert.deepEqual(payload,{aps:{alert:{title:'Agent Remote',body:'Your agent has replied.'},sound:'default','mutable-content':1},hostId:good.hostId,sessionId:'claude:1',kind:'reply',e2e});
  assert.ok(Buffer.byteLength(sent[0].payload)<=4096);
  assert.equal((await p.push('host',{...good,e2e:'A'.repeat(1500),'mutable-content':1,alert:{...good.alert,title:'t'.repeat(64),body:'b'.repeat(180)},session:'s'.repeat(200)})).ok,true,'the largest legal request fits Apple\'s 4 KB');
  const logged=[],log=console.log;console.log=(...a)=>logged.push(a.join(' '));t.after(()=>{console.log=log;});
  await p.push('host',{...rich,alert:{kind:'test',title:'Agent Remote',body:'Notifications from your Mac are working.'}});console.log=log;
  assert.equal(logged.length,1);assert.equal(logged[0].includes(e2e.slice(0,40)),false);assert.equal(logged[0].includes(token),false);
});
test('each host is rate limited per minute and per day, independently of other hosts',async()=>{
  const {p,sent,advance}=pusher({perMinute:3,perDay:5});
  for(let i=0;i<3;i++)assert.equal((await p.push('a',good)).ok,true);
  assert.deepEqual(await p.push('a',good),{ok:false,status:429,reason:'TooManyRequests'});
  assert.equal((await p.push('b',good)).ok,true,'another Mac is unaffected');
  advance(61_000);assert.equal((await p.push('a',good)).ok,true);assert.equal((await p.push('a',good)).ok,true);
  advance(61_000);assert.equal((await p.push('a',good)).status,429,'daily cap');
  advance(86_400_000);assert.equal((await p.push('a',good)).ok,true);
  assert.equal(sent.length,7);
});
test('the ES256 provider token is cached for 50 minutes, verifies, and is renewed when Apple rejects it',async()=>{
  let reply={status:200,reason:''};const {p,sent,advance}=pusher({status:()=>reply,perMinute:100});
  await p.push('h',good);advance(49*60_000);await p.push('h',good);
  assert.equal(sent[0].jwt,sent[1].jwt);
  const [header,claims,signature]=sent[0].jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',kid:'KEY123'});assert.equal(JSON.parse(Buffer.from(claims,'base64url')).iss,'TEAM123');
  assert.ok(verify('sha256',Buffer.from(header+'.'+claims),{key:createPublicKey(keys.privateKey),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
  advance(2*60_000);await p.push('h',good);assert.notEqual(sent[2].jwt,sent[1].jwt,'renewed after 50 minutes');
  reply={status:403,reason:'ExpiredProviderToken'};assert.deepEqual(await p.push('h',good),{ok:false,status:403,reason:'ExpiredProviderToken'});
  reply={status:200,reason:''};advance(1000);await p.push('h',good);assert.notEqual(sent[4].jwt,sent[3].jwt,'re-signed after rejection');
  reply={status:410,reason:'Unregistered'};assert.deepEqual(await p.push('h',good),{ok:false,status:410,reason:'Unregistered'});
});

async function host(endpoint){
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');const ws=new WebSocket(endpoint+'/v1/host');const messages=[];
  const {hostFingerprint}=await import('../../shared/secure-channel.mjs');const der=publicKey.export({type:'spki',format:'der'}),fingerprint=hostFingerprint(der);
  ws.on('message',data=>{const m=JSON.parse(data);if(m.type==='challenge')ws.send(JSON.stringify({type:'register',publicKey:der.toString('base64'),signature:sign(null,Buffer.from(`agent-remote-host/v1\n${m.challenge}\n${fingerprint}`),privateKey).toString('base64')}));else messages.push(m);});
  const next=type=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout waiting for '+type)),5000);const check=()=>{const i=messages.findIndex(m=>m.type===type);if(i>=0){clearTimeout(timer);resolve(messages.splice(i,1)[0]);}else setTimeout(check,5);};check();});
  return {ws,next};
}
test('hosts learn the push capability at registration and get a push-result per request',async t=>{
  const sent=[];const relay=createRelay({push:{...pushConfig({APNS_KEY_P8:pem,APNS_KEY_ID:'K',APNS_TEAM_ID:'T'}),send:async r=>{sent.push(r);return r.token.startsWith('dead')?{status:410,reason:'Unregistered'}:{status:200,reason:''};}}});
  const plain=createRelay();
  for(const r of [relay,plain])await new Promise(resolve=>r.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await relay.close();await plain.close();});
  const h=await host(`ws://127.0.0.1:${relay.server.address().port}`);
  assert.deepEqual((await h.next('registered')).capabilities,['push']);
  h.ws.send(JSON.stringify({type:'push',id:'one',...good}));assert.deepEqual(await h.next('push-result'),{type:'push-result',id:'one',ok:true,status:200,reason:''});
  h.ws.send(JSON.stringify({type:'push',id:'two',...good,token:'dead'+'0'.repeat(60)}));assert.deepEqual(await h.next('push-result'),{type:'push-result',id:'two',ok:false,status:410,reason:'Unregistered'});
  h.ws.send(JSON.stringify({type:'push',id:'three',...good,topic:'com.other'}));assert.equal((await h.next('push-result')).reason,'TopicDisallowed');
  assert.equal(sent.length,2);
  const old=await host(`ws://127.0.0.1:${plain.server.address().port}`);
  const registered=await old.next('registered');assert.equal(registered.capabilities,undefined,'a relay without Apple keys advertises nothing');
  old.ws.send(JSON.stringify({type:'push',id:'x',...good}));assert.deepEqual(await old.next('push-result'),{type:'push-result',id:'x',ok:false,status:503,reason:'PushUnavailable'});
  const closed=once(h.ws,'close');h.ws.send(JSON.stringify({type:'push',...good}));assert.equal((await closed)[0],1008,'a push without an id is a protocol error');
  old.ws.terminate();
});
