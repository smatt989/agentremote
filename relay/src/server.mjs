import http from 'node:http';
import http2 from 'node:http2';
import { randomBytes, randomUUID, createPublicKey, createPrivateKey, verify, sign, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { hostFingerprint, validatePacket, MAX_PACKET_BYTES } from '../../shared/secure-channel.mjs';

// Optional Apple Push sender, so a Mac without its own APNs key can still alert its phones. Configured only by
// APNS_KEY_P8 (PEM text), APNS_KEY_ID, APNS_TEAM_ID and optionally APNS_TOPICS (comma-separated bundle IDs).
// Hosts send only a device token, a generic alert ({kind,title,body}), a session id and optionally `e2e`: rich alert content
// sealed by the Mac for that one device (AES-256-GCM), which the relay cannot read and passes through with `mutable-content`
// so the iPhone's Notification Service Extension can open it. Tokens, alert text and `e2e` are never logged.
export const PUSH_KINDS=['reply','question','test','auth'];
export const E2E_MAX=1500;
export function pushConfig(env=process.env){
  if(!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID)return null;
  const key=createPrivateKey(env.APNS_KEY_P8.replace(/\\n/g,'\n'));if(key.asymmetricKeyType!=='ec')throw new Error('APNS_KEY_P8 must be an Apple .p8 (EC P-256) key.');
  return {key,keyId:env.APNS_KEY_ID.trim(),teamId:env.APNS_TEAM_ID.trim(),topics:(env.APNS_TOPICS||'com.agentremote.iphone').split(',').map(t=>t.trim()).filter(Boolean)};
}
const apnsSessions=new Map();
// One reused HTTP/2 connection per APNs environment, as Apple asks. Resolves {status,reason}; never rejects.
export function apnsSend({environment,token,topic,jwt,payload,collapseId,expiration}){
  const origin=environment==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com';
  let client=apnsSessions.get(origin);
  const forget=()=>{if(apnsSessions.get(origin)===client)apnsSessions.delete(origin);};
  if(!client || client.closed || client.destroyed){
    client=http2.connect(origin);client.on('error',()=>{});client.on('close',forget);client.on('goaway',forget);
    client.setTimeout(30*60_000,()=>client.close());client.unref();apnsSessions.set(origin,client);
  }
  return new Promise(resolve=>{
    let status=0,body='',settled=false,request;
    const done=(code,reason)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({status:code,reason});};
    const timer=setTimeout(()=>{try{request?.close(http2.constants.NGHTTP2_CANCEL);}catch{}done(504,'Timeout');},15_000);
    try{request=client.request({':method':'POST',':path':'/3/device/'+token,authorization:'bearer '+jwt,'apns-topic':topic,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(expiration),'apns-collapse-id':collapseId});}
    catch{forget();client.destroy();return done(502,'ConnectionError');}
    request.setEncoding('utf8');request.on('response',headers=>{status=headers[':status'];});request.on('data',chunk=>{if(body.length<4096)body+=chunk;});
    request.on('end',()=>{let reason='';try{reason=JSON.parse(body).reason||'';}catch{}done(status||502,reason);});request.on('error',()=>done(502,'ConnectionError'));
    request.end(payload);
  });
}
export function createPusher({key,keyId,teamId,topics,send=apnsSend,now=()=>Date.now(),perMinute=30,perDay=500,concurrent=8}){
  let jwt,jwtAt=0;const rates=new Map(),fail=reason=>({ok:false,status:400,reason});
  // Apple accepts a provider token for an hour and throttles re-signing; reuse one for 50 minutes.
  const providerToken=()=>{
    if(jwt && now()-jwtAt<50*60_000)return jwt;
    const iat=Math.floor(now()/1000),input=Buffer.from(JSON.stringify({alg:'ES256',kid:keyId})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iss:teamId,iat})).toString('base64url');
    jwt=input+'.'+sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');jwtAt=now();return jwt;
  };
  async function push(host,m){
    const alert=m.alert;
    if(!['production','development'].includes(m.environment))return fail('BadEnvironment');
    if(typeof m.topic!=='string' || !topics.includes(m.topic))return fail('TopicDisallowed');
    if(typeof m.token!=='string' || !/^[0-9a-f]{64,200}$/i.test(m.token))return fail('BadDeviceToken');
    if(!alert || typeof alert!=='object' || !PUSH_KINDS.includes(alert.kind) || typeof alert.title!=='string' || !alert.title || alert.title.length>64 || typeof alert.body!=='string' || !alert.body || alert.body.length>180)return fail('BadAlert');
    if(m.session!==undefined && (typeof m.session!=='string' || !m.session || m.session.length>200))return fail('BadSession');
    if(m.hostId!==undefined && (typeof m.hostId!=='string' || !/^[A-Za-z0-9-]{1,100}$/.test(m.hostId)))return fail('BadHostId');
    // Opaque to the relay: only its type, size and base64 alphabet are checked. It is useless without the hostId and session it is bound to.
    if(m.e2e!==undefined && (typeof m.e2e!=='string' || m.e2e.length<40 || m.e2e.length>E2E_MAX || m.e2e.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(m.e2e) || !m.hostId || !m.session || alert.kind==='auth'))return fail('BadE2E');
    // The two travel together: mutable-content without e2e would wake the extension for nothing.
    if((m['mutable-content']!==undefined || m.e2e!==undefined) && (m['mutable-content']!==1 || m.e2e===undefined))return fail('BadE2E');
    const e2e=m.e2e??null;
    const payload=JSON.stringify({aps:{alert:{title:alert.title,body:alert.body},sound:'default',...(alert.kind==='question'?{'interruption-level':'time-sensitive'}:{}),...(e2e?{'mutable-content':1}:{})},...(m.hostId?{hostId:m.hostId}:{}),...(m.session && alert.kind!=='auth'?{sessionId:m.session}:{}),kind:alert.kind,...(e2e?{e2e}:{})});
    // Without e2e the generic payload stays under 2 KB as before; with it, under Apple's 4 KB limit.
    if(Buffer.byteLength(payload)>(e2e?4096:2048))return fail('PayloadTooLarge');
    const t=now();let rate=rates.get(host);
    if(!rate || t>rate.dayUntil)rate={minute:0,minuteUntil:t+60_000,day:0,dayUntil:t+86_400_000,inflight:0};
    if(t>rate.minuteUntil){rate.minute=0;rate.minuteUntil=t+60_000;}
    rates.set(host,rate);
    if(rate.minute>=perMinute || rate.day>=perDay || rate.inflight>=concurrent)return {ok:false,status:429,reason:'TooManyRequests'};
    rate.minute++;rate.day++;rate.inflight++;
    try{
      const result=await send({environment:m.environment,token:m.token,topic:m.topic,jwt:providerToken(),payload,collapseId:createHash('sha256').update(m.session||alert.kind).digest('hex'),expiration:Math.floor(t/1000)+3600});
      if(result.status===403 && /ProviderToken/.test(result.reason||''))jwt=null;
      if(result.status!==200)console.log(`Push (${alert.kind}) not delivered: APNs ${result.status}${result.reason?' '+result.reason:''}`);
      return {ok:result.status===200,status:result.status,reason:result.reason||''};
    }finally{rate.inflight--;}
  }
  function sweep(){const t=now();for(const [host,rate] of rates)if(t>rate.dayUntil)rates.delete(host);}
  return {topics,push,sweep};
}

// The relay only knows public routing headers, public identity keys, and ciphertext.
// It deliberately has no database, provider integration, or plaintext payload logger.
// Limits are per Mac where possible, so one busy Mac cannot crowd out the rest. The daily byte allowance per Mac
// (requests plus responses) bounds what a shared relay carries; self-hosted relays can raise it.
export function createRelay({ maxConnections=5000, maxPending=4096, maxPendingPerHost=64, maxPendingBytes=256_000_000, hostDailyBytes=2_000_000_000, requestTimeout=50_000, heartbeatInterval=25_000, push=null }={}) {
  const hosts=new Map(), pending=new Map(), addresses=new Map(), usage=new Map(); let pendingBytes=0;
  // Bytes carried for one Mac in the current 24-hour window; false once the allowance is used up.
  const charge=(host,bytes)=>{const t=Date.now();let u=usage.get(host);if(!u || t>u.until){u={bytes:0,until:t+86_400_000};usage.set(host,u);}u.bytes+=bytes;return u.bytes<=hostDailyBytes;};
  const pusher=push?createPusher(push):null;
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method==='GET' && req.url==='/healthz') {res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"ok":true,"protocol":1}');}
    res.writeHead(404);res.end();
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:MAX_PACKET_BYTES,perMessageDeflate:false});
  function send(socket,message) {
    if(socket.readyState!==WebSocket.OPEN)return false;
    if(socket.bufferedAmount>MAX_PACKET_BYTES){socket.close(1013,'Connection is too slow.');return false;}
    socket.send(JSON.stringify(message));return true;
  }
  function finish(route,error) {
    const item=pending.get(route);if(!item)return;
    clearTimeout(item.timer);pending.delete(route);pendingBytes-=item.bytes;item.client.outstanding--;item.host.pending--;
    if(error)send(item.client,{type:'unavailable',id:item.id,reason:error});
  }
  server.on('upgrade',(req,socket,head)=>{
    const path=req.url;
    const address=req.socket.remoteAddress || 'unknown';
    const now=Date.now();let rate=addresses.get(address);
    if(!rate || now>rate.until){rate={count:0,until:now+60_000};addresses.set(address,rate);}
    // Do not trust caller-provided X-Forwarded-For. Rate limit at the ingress too.
    if(req.headers.origin || !['/v1/host','/v1/client'].includes(path) || wss.clients.size>=maxConnections || ++rate.count>120){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,path));
  });
  wss.on('connection',(ws,path)=>{
    ws.alive=true;ws.outstanding=0;ws.pending=0;ws.budget={count:0,until:Date.now()+60_000};
    ws.on('pong',()=>{ws.alive=true;}); ws.on('error',()=>{});
    const role=path==='/v1/host'?'host':'client';
    const challenge=randomBytes(32).toString('base64');
    let registered=false;
    const authTimer=role==='host'?setTimeout(()=>{if(!registered)ws.close(1008,'Registration expired.');},10_000):null;
    if(role==='host')send(ws,{type:'challenge',challenge});
    ws.on('message',(data,isBinary)=>{
      try {
        if(isBinary)throw new Error('Text envelopes required.');
        if(Date.now()>ws.budget.until)ws.budget={count:0,until:Date.now()+60_000};
        if(++ws.budget.count>600)throw new Error('Rate limit exceeded.');
        const message=JSON.parse(data.toString());
        if(role==='host' && !registered){
          if(message.type!=='register' || typeof message.publicKey!=='string' || message.publicKey.length>200 || typeof message.signature!=='string' || message.signature.length>100)throw new Error('Invalid registration.');
          const der=Buffer.from(message.publicKey,'base64');const host=hostFingerprint(der);
          const publicKey=createPublicKey({key:der,type:'spki',format:'der'});
          if(publicKey.asymmetricKeyType!=='ed25519' || !verify(null,Buffer.from(`agent-remote-host/v1\n${challenge}\n${host}`),publicKey,Buffer.from(message.signature,'base64')))throw new Error('Invalid host signature.');
          registered=true;clearTimeout(authTimer);ws.host=host;
          const previous=hosts.get(host);if(previous && previous!==ws)previous.close(1000,'Reconnected.');
          // Extra fields are ignored by older Macs; newer ones only send {type:'push'} after seeing the capability.
          hosts.set(host,ws);send(ws,{type:'registered',host,...(pusher?{capabilities:['push'],pushTopics:pusher.topics}:{})});return;
        }
        if(role==='client' && message.type==='request'){
          const packet=message.packet;validatePacket(packet);
          const host=hosts.get(packet.host);
          if(!host || host.readyState!==WebSocket.OPEN){send(ws,{type:'unavailable',id:packet.id,reason:'mac_offline'});return;}
          if(ws.outstanding>=4 || host.pending>=maxPendingPerHost || pendingBytes+data.length>maxPendingBytes || pending.size>=maxPending){send(ws,{type:'unavailable',id:packet.id,reason:'relay_busy'});return;}
          if(!charge(packet.host,data.length)){send(ws,{type:'unavailable',id:packet.id,reason:'relay_quota'});return;}
          const route=randomUUID();ws.outstanding++;host.pending++;pendingBytes+=data.length;
          pending.set(route,{client:ws,host,id:packet.id,channel:packet.channel,issuedAt:packet.issuedAt,bytes:data.length,timer:setTimeout(()=>finish(route,'request_timeout'),requestTimeout)});
          if(!send(host,{type:'request',route,packet}))finish(route,'mac_offline');
          return;
        }
        if(role==='host' && registered && message.type==='response'){
          const item=pending.get(message.route);if(!item || item.host!==ws)return;
          validatePacket(message.packet);
          if(message.packet.host!==ws.host || message.packet.id!==item.id || message.packet.channel!==item.channel || message.packet.issuedAt!==item.issuedAt)throw new Error('Mismatched response.');
          if(!charge(ws.host,data.length)){finish(message.route,'relay_quota');return;}
          send(item.client,{type:'response',packet:message.packet});finish(message.route);return;
        }
        if(role==='host' && registered && message.type==='push'){
          if(typeof message.id!=='string' || !message.id || message.id.length>100)throw new Error('Invalid push.');
          const id=message.id;
          if(!pusher){send(ws,{type:'push-result',id,ok:false,status:503,reason:'PushUnavailable'});return;}
          pusher.push(ws.host,message).catch(()=>({ok:false,status:500,reason:'InternalError'})).then(result=>send(ws,{type:'push-result',id,...result}));return;
        }
        if(role==='host' && registered && message.type==='rejected'){
          const item=pending.get(message.route);if(item?.host===ws)finish(message.route,'device_not_authorized');return;
        }
        throw new Error('Unexpected message.');
      }catch{ws.close(1008,'Invalid protocol message.');}
    });
    ws.on('close',()=>{
      clearTimeout(authTimer);
      if(ws.host && hosts.get(ws.host)===ws)hosts.delete(ws.host);
      for(const [route,item] of pending)if(item.client===ws || item.host===ws)finish(route,item.host===ws?'mac_offline':undefined);
    });
  });
  const timer=setInterval(()=>{
    for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}
    for(const [address,rate] of addresses)if(Date.now()>rate.until)addresses.delete(address);
    for(const [host,u] of usage)if(Date.now()>u.until)usage.delete(host);
    pusher?.sweep();
  },heartbeatInterval);timer.unref();
  async function close(){clearInterval(timer);for(const ws of wss.clients)ws.terminate();for(const route of [...pending.keys()])finish(route);await new Promise(resolve=>server.close(resolve));}
  return {server,close,stats:()=>({hosts:hosts.size,connections:wss.clients.size,pending:pending.size,pendingBytes})};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  let push=null;try{push=pushConfig(process.env);}catch(error){console.error(`Push disabled: ${error.message}`);}
  const limit=(name,fallback)=>{const value=Number(process.env[name]);return Number.isFinite(value)&&value>0?value:fallback;};
  const relay=createRelay({push,maxConnections:limit('RELAY_MAX_CONNECTIONS',5000),hostDailyBytes:limit('RELAY_HOST_DAILY_BYTES',2_000_000_000)});const port=Number(process.env.PORT || 8790);
  relay.server.listen(port,'0.0.0.0',()=>console.log(`Agent Remote relay listening on port ${port}. TLS must terminate at the hosting ingress. Push: ${push?'enabled for '+push.topics.join(', '):'not configured'}.`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>relay.close().then(()=>process.exit(0)));
}
