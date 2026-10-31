import { connect } from 'node:http2';
import { createPrivateKey, sign, createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './store.mjs';
import { pendingQuestions } from './questions.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
// The visible alert text is generic on purpose: no conversation text or project names reach Apple or the relay in clear.
// The useful part (chat title, first line of the reply, the question and its options) travels as `e2e`, sealed for one
// paired device with that device's relay secret; the iPhone's Notification Service Extension opens it (see sealPush).
export const ALERTS={
  reply:{kind:'reply',title:'Agent Remote',body:'Your agent has replied.'},
  question:{kind:'question',title:'Agent Remote',body:'Your agent has a question for you.'},
  test:{kind:'test',title:'Agent Remote',body:'Notifications from your Mac are working.'},
  authExpiring:{kind:'auth',title:'Agent Remote',body:'Claude’s sign-in on your Mac expires soon. Tap to renew it from your phone.'},
  authExpired:{kind:'auth',title:'Agent Remote',body:'Claude is signed out on your Mac. Tap to sign in from your phone.'},
};
export const E2E_MAX=1500,BODY_MAX=140,QUESTION_MAX=200,TITLE_MAX=64;
// AES-256-GCM like the secure channel, with its own HKDF label so a push key never equals a request/response key.
export const pushKey=(secret,hostId)=>Buffer.from(hkdfSync('sha256',secret,Buffer.from(hostId),Buffer.from('agent-remote/v1/push'),32));
export const pushAAD=(hostId,session,kind)=>Buffer.from(`agent-remote/v1/push\n${hostId}\n${session}\n${kind}`);
export function sealPush(secret,hostId,session,kind,content,nonce=randomBytes(12)){
  const cipher=createCipheriv('aes-256-gcm',pushKey(secret,hostId),nonce);cipher.setAAD(pushAAD(hostId,session,kind));
  const ciphertext=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(content))),cipher.final()]);
  return Buffer.concat([nonce,ciphertext,cipher.getAuthTag()]).toString('base64');
}
export function openPush(secret,hostId,session,kind,e2e){
  const box=Buffer.from(e2e,'base64'),decipher=createDecipheriv('aes-256-gcm',pushKey(secret,hostId),box.subarray(0,12));
  decipher.setAAD(pushAAD(hostId,session,kind));decipher.setAuthTag(box.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(box.subarray(12,-16)),decipher.final()]).toString('utf8'));
}
const clip=(text,max)=>{const chars=Array.from(text);return chars.length>max?chars.slice(0,max-1).join('').trimEnd()+'…':text;};
/** The first line of a reply that reads as prose: code blocks, rules, tables and empty markup are skipped; markdown is stripped. */
export function previewLine(text,max=BODY_MAX){
  // A heading ("## Summary") is used only when no prose line follows it.
  let fenced=false,heading='';
  for(const raw of String(text||'').split(/\r?\n/)){
    if(/^\s*(```|~~~)/.test(raw)){fenced=!fenced;continue;}
    if(fenced||/^\s*(?:[-*_]\s*){3,}$/.test(raw)||/^\s*\|?\s*:?-{2,}/.test(raw))continue;
    const line=raw.replace(/<[^>]+>/g,'').replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/,'')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/`+/g,'').replace(/(\*\*|__|~~)(.+?)\1/g,'$2')
      .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g,'$1$2').replace(/^\|\s*|\s*\|$/g,'').replace(/\s*\|\s*/g,' · ').replace(/\s+/g,' ').trim();
    if(!/[\p{L}\p{N}]/u.test(line))continue;
    if(/^\s{0,3}#{1,6}\s/.test(raw)){heading||=line;continue;}
    return clip(line,max);
  }
  return clip(heading,max);
}
export class ReplyNotifier {
  constructor(store,providers,{send,relay}={}) {
    this.store=store;this.providers=providers;this.relay=relay;this.deliver=send||((device,session,alert,content)=>this.push(device,session,alert,content));this.busy=false;this.historyVersions=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS push_devices(device TEXT PRIMARY KEY, token TEXT NOT NULL, topic TEXT NOT NULL, environment TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_receipts(device TEXT NOT NULL,session TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(device,session));
      CREATE TABLE IF NOT EXISTS push_question_receipts(device TEXT NOT NULL,question TEXT NOT NULL,PRIMARY KEY(device,question));
      CREATE TABLE IF NOT EXISTS push_auth_receipts(device TEXT NOT NULL,alert TEXT NOT NULL,PRIMARY KEY(device,alert));`);
  }
  config(){try{return JSON.parse(readFileSync(join(this.store.directory,'push-config.json'),'utf8'));}catch{return null;}}
  // A Mac with its own Apple key (push-config.json) sends directly; otherwise the relay's sender is used when it offers one.
  local(){const c=this.config();return c?.keyPath&&c?.keyId&&c?.teamId&&c?.topics?.length?c:null;}
  topics(){return this.local()?.topics||this.relay?.pushTopics?.()||[];}
  status(){return {configured:this.topics().length>0,alerts:['reply','question']};}
  devices(){return this.store.db.prepare('SELECT p.* FROM push_devices p JOIN devices d ON p.device=d.id').all();}
  register(auth,value){
    const device=this.store.db.prepare('SELECT id FROM devices WHERE hash=?').get(digest(auth));if(!device)throw fail('Pair this iPhone before registering notifications.',403);
    if(value.enabled===false){for(const table of ['push_devices','push_receipts','push_question_receipts','push_auth_receipts'])this.store.db.prepare(`DELETE FROM ${table} WHERE device=?`).run(device.id);return {enabled:false,...this.status()};}
    if(!this.status().configured)throw fail('Background reply notifications need Apple Push setup on the Mac.',503);
    if(typeof value.token!=='string'||! /^[a-f0-9]{64,512}$/i.test(value.token)||!this.topics().includes(value.topic)||!['development','production'].includes(value.environment))throw fail('Invalid push registration.');
    const old=this.store.db.prepare('SELECT device FROM push_devices WHERE device=?').get(device.id);
    this.store.db.prepare('INSERT INTO push_devices VALUES (?,?,?,?) ON CONFLICT(device) DO UPDATE SET token=excluded.token,topic=excluded.topic,environment=excluded.environment').run(device.id,value.token,value.topic,value.environment);
    // Existing replies are history, not news. A question that is still waiting is news.
    if(!old)for(const s of this.store.sessions())if(s.latestAssistantToken)this.receipt(device.id,s.id,s.latestAssistantToken);
    return {enabled:true,...this.status()};
  }
  receipt(device,id,token){this.store.db.prepare('INSERT INTO push_receipts VALUES (?,?,?) ON CONFLICT(device,session) DO UPDATE SET token=excluded.token').run(device,id,token);}
  questionReceipt(device,question){this.store.db.prepare('INSERT OR IGNORE INTO push_question_receipts VALUES (?,?)').run(device,question);}
  start(){if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),10000);this.timer.unref();}}
  close(){clearInterval(this.timer);this.timer=null;}
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      const devices=this.devices();if(!devices.length)return;
      await this.authAlerts(devices);
      await this.providers.discover();
      for(const s of this.store.sessions()){
        // Sessions the service does not stream itself (desktop Claude clients, shared
        // terminals, Codex terminals) only import replies and questions on refresh.
        if(s.external||s.terminal)try{const raw=this.store.session(s.id),version=raw.transcript?statSync(raw.transcript).mtimeMs:raw.updatedAt;
          if(this.historyVersions.get(s.id)!==version){await this.providers.history(s.id);this.historyVersions.set(s.id,version);}}catch{}
        const current=this.store.sessionView(this.store.session(s.id));if(!current)continue;
        const question=pendingQuestions(this.store,current.id)[0];
        for(const device of devices){
          try{
            if(question){
              if(this.store.db.prepare('SELECT 1 FROM push_question_receipts WHERE device=? AND question=?').get(device.device,question.id))continue;
              await this.deliver(device,current,ALERTS.question,this.questionContent(current,question));this.questionReceipt(device.device,question.id);
              // The reply that introduced this question is covered by the question alert.
              if(current.latestAssistantToken)this.receipt(device.device,current.id,current.latestAssistantToken);
              continue;
            }
            if(!current.latestAssistantToken||['running','submitting','compacting'].includes(current.status))continue;
            const seen=this.store.db.prepare('SELECT token FROM push_receipts WHERE device=? AND session=?').get(device.device,current.id);
            if(seen?.token===current.latestAssistantToken)continue;
            if(current.unread===false){this.receipt(device.device,current.id,current.latestAssistantToken);continue;}
            await this.deliver(device,current,ALERTS.reply,this.replyContent(current));this.receipt(device.device,current.id,current.latestAssistantToken);
          }catch(e){if(e.invalidToken)this.store.db.prepare('DELETE FROM push_devices WHERE device=?').run(device.device);}
        }
      }
    }finally{this.busy=false;}
  }
  // What the phone shows once it has decrypted `e2e`. `reply` says whether the notification may offer a Reply field
  // (sessions the phone cannot type into, such as shared terminals, open the chat instead).
  title(session){return clip(String(session.title||'').replace(/\s+/g,' ').trim()||'Agent Remote',TITLE_MAX);}
  replyContent(session){
    let text='';try{text=JSON.parse(this.store.db.prepare('SELECT data FROM messages WHERE session=? AND id=?').get(session.id,session.latestAssistantMessageId)?.data||'{}').text;}catch{}
    return {v:1,kind:'reply',session:session.id,title:this.title(session),body:previewLine(text)||ALERTS.reply.body,reply:!['terminal','external-live'].includes(session.control)&&!session.terminal};
  }
  questionContent(session,question){
    const items=question.questions||[],first=items[0]||{};
    const body=clip(String(first.title||'').replace(/\s+/g,' ').trim(),QUESTION_MAX)+(items.length>1?` (+${items.length-1} more)`:'');
    // Only a single-item question can be answered from the notification: the answer route needs one answer per item.
    const answerable=items.length===1&&question.readOnly!==true;
    return {v:1,kind:'question',session:session.id,title:this.title(session),body:body.trim()||ALERTS.question.body,
      ...(answerable?{question:{id:question.id,item:String(first.id),options:(first.options||[]).slice(0,3).map(o=>String(o.label))}}:{})};
  }
  secret(device){try{const row=this.store.db.prepare('SELECT secret FROM relay_devices WHERE id=?').get(device);return row?Buffer.from(row.secret,'base64'):null;}catch{return null;}}
  /** Seals `content` for this device, shrinking it until it fits E2E_MAX. Null when the device has no relay secret (direct pairing). */
  e2e(device,session,alert,content){
    const secret=content&&session?.id&&this.secret(device.device);if(!secret||secret.length!==32)return null;
    const seal=value=>sealPush(secret,this.store.hostId,session.id,alert.kind,value);
    let value=content,box=seal(value);
    // Option labels are sent whole (they are the answer), so drop the buttons before shortening the text.
    if(box.length>E2E_MAX&&value.question?.options?.length){value={...value,question:{...value.question,options:[]}};box=seal(value);}
    for(let max=100;box.length>E2E_MAX&&max>=20;max-=20){value={...value,title:clip(value.title,Math.min(TITLE_MAX,max)),body:clip(value.body,max)};box=seal(value);}
    return box.length<=E2E_MAX?box:null;
  }
  /** The APNs JSON for the direct (local key) path. The relay builds the same shape from the same fields. */
  apnsPayload(device,session,alert,content){
    const e2e=this.e2e(device,session,alert,content);
    return JSON.stringify({aps:{alert:{title:alert.title,body:alert.body},sound:'default',...(alert.kind==='question'?{'interruption-level':'time-sensitive'}:{}),...(e2e?{'mutable-content':1}:{})},hostId:this.store.hostId,...(alert.kind==='auth'?{}:{sessionId:session.id}),kind:alert.kind,...(e2e?{e2e}:{})});
  }
  // One alert per expiry threshold (3 days, 1 day) and one per lapsed login, per phone.
  async authAlerts(devices){
    let status;try{status=this.providers.claudeAuth?.status();}catch{return;}
    if(!status?.alertKey)return;
    const alert=status.state==='expired'?ALERTS.authExpired:ALERTS.authExpiring;
    for(const device of devices){
      if(this.store.db.prepare('SELECT 1 FROM push_auth_receipts WHERE device=? AND alert=?').get(device.device,status.alertKey))continue;
      try{await this.deliver(device,{id:'claude-auth'},alert);this.store.db.prepare('INSERT OR IGNORE INTO push_auth_receipts VALUES (?,?)').run(device.device,status.alertKey);}
      catch(e){if(e.invalidToken)this.store.db.prepare('DELETE FROM push_devices WHERE device=?').run(device.device);}
    }
  }
  async push(device,session,alert=ALERTS.reply,content=null){
    const c=this.local();
    if(!c){
      if(!this.relay?.pushTopics?.())throw fail('Push not configured');
      // The same generic alert as the direct path; the relay sees a device token, the alert kind/text, a session id and
      // the sealed `e2e` box it cannot open. Relays older than e2e support ignore the extra fields and send the generic alert.
      const e2e=this.e2e(device,session,alert,content);
      const result=await this.relay.push({token:device.token,environment:device.environment,topic:device.topic,alert:{kind:alert.kind,title:alert.title,body:alert.body},hostId:this.store.hostId,...(alert.kind==='auth'?{}:{session:session.id}),...(e2e?{e2e,'mutable-content':1}:{})});
      if(!result.ok)throw Object.assign(Error('APNs rejected the notification'+(result.reason?' ('+result.reason+')':'')+(result.status?' status '+result.status:'')),{invalidToken:result.status===410||result.reason==='BadDeviceToken'||result.reason==='Unregistered'});
      return;
    }
    const now=Math.floor(Date.now()/1000);
    if(!this.jwt||now-this.jwtAt>3000){
      const header=Buffer.from(JSON.stringify({alg:'ES256',kid:c.keyId})).toString('base64url');
      const payload=Buffer.from(JSON.stringify({iss:c.teamId,iat:now})).toString('base64url');
      const input=header+'.'+payload,key=createPrivateKey(readFileSync(c.keyPath));
      this.jwt=input+'.'+sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');this.jwtAt=now;
    }
    // No readable conversation content or project name is sent to Apple's notification service.
    const body=this.apnsPayload(device,session,alert,content);
    const client=connect(device.environment==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com');
    try{await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{client.destroy();reject(Error('APNs timed out'));},15000);
      client.on('error',e=>{clearTimeout(timer);reject(e);});
      const request=client.request({':method':'POST',':path':'/3/device/'+device.token,authorization:'bearer '+this.jwt,'apns-topic':device.topic,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(now+3600),'apns-collapse-id':createHash('sha256').update(session.id).digest('hex')});
      let status,detail='';request.on('response',h=>{status=h[':status'];});request.on('data',chunk=>{detail+=chunk;});request.on('error',e=>{clearTimeout(timer);reject(e);});
      request.on('end',()=>{clearTimeout(timer);if(status===200)resolve();else{let reason='';try{reason=JSON.parse(detail).reason||'';}catch{}reject(Object.assign(Error('APNs rejected the notification'+(reason?' ('+reason+')':'')+(status?' status '+status:'')),{invalidToken:status===410||reason==='BadDeviceToken'||reason==='Unregistered'}));}});request.end(body);
    });}finally{client.close();}
  }
}
