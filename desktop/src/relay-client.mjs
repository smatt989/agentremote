import { WebSocket } from 'ws';
import { sign, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, seal, validatePacket, MAX_PACKET_BYTES } from '../../shared/secure-channel.mjs';
import { RelayState } from './relay-state.mjs';

// Paths a paired device may reach through the relay; everything else is refused before it reaches the local API.
export const relayRoute = path => /^\/(health$|agents$|usage$|folders\/recent$|pairing\/invite$|notifications\/(?:status|device)$|memory(?:$|\?|\/forget$)|knowledge(?:$|\?|\/(?:page|index|talk)(?:$|\?))|settings\/(?:models|session-preferences|keep-awake)$|claude\/auth(?:$|\/login(?:$|\/(?:code|cancel)$))|sessions(?:$|\?|\/)|artifacts\/)/.test(path);
export class DesktopRelay extends EventEmitter {
  constructor({store,apiURL,state=new RelayState(store)}){super();this.store=store;this.state=state;this.apiURL=apiURL;this.stopped=true;this.inflight=0;this.inflightBytes=0;this.generation=0;this.pushes=new Map();}
  // Topics the relay can push for, remembered across restarts so notification status does not flicker while reconnecting.
  pushTopics(){try{const value=JSON.parse(this.state.setting('relayPushTopics')||'null');return Array.isArray(value)&&value.length?value:null;}catch{return null;}}
  /** Send one alert through the relay's Apple Push sender. Resolves {ok,status,reason}; rejects when the relay cannot be reached. */
  push(message,{timeout=20_000}={}){
    const ws=this.socket;
    if(!this.registered||ws?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('The relay is not connected.'));
    if(!this.pushTopics())return Promise.reject(new Error('The relay does not offer notifications.'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pushes.delete(id);reject(new Error('The relay did not confirm the notification.'));},timeout);timer.unref?.();
      this.pushes.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      ws.send(JSON.stringify({...message,type:'push',id}));
    });
  }
  start(){this.stopped=false;this.connect();}
  connect(){
    if(this.stopped)return;
    const endpoint=this.state.endpoint();if(!endpoint){this.emit('status','unconfigured');return;}
    const generation=++this.generation;this.registered=false;
    const ws=new WebSocket(endpoint+'/v1/host',{maxPayload:MAX_PACKET_BYTES,perMessageDeflate:false,handshakeTimeout:15_000,followRedirects:false});this.socket=ws;
    let lastTraffic=Date.now();
    const heartbeat=setInterval(()=>{if(Date.now()-lastTraffic>60_000)ws.terminate();},15_000);heartbeat.unref();
    ws.on('ping',()=>{lastTraffic=Date.now();});
    ws.on('error',()=>{});
    ws.on('message',async data=>{
      lastTraffic=Date.now();
      let message;try{message=JSON.parse(data);}catch{return;}
      if(message.type==='challenge'){
        if(typeof message.challenge!=='string' || message.challenge.length>100){ws.close();return;}
        const signature=sign(null,Buffer.from(`agent-remote-host/v1\n${message.challenge}\n${this.state.host}`),this.state.privateKey).toString('base64');
        ws.send(JSON.stringify({type:'register',publicKey:this.state.publicKey.toString('base64'),signature}));
      }else if(message.type==='registered'){
        // Older relays send no capabilities; then this Mac only pushes with its own Apple key (push-config.json).
        const topics=Array.isArray(message.capabilities)&&message.capabilities.includes('push')&&Array.isArray(message.pushTopics)?message.pushTopics.filter(t=>typeof t==='string'&&/^[A-Za-z0-9.-]{1,200}$/.test(t)).slice(0,20):[];
        if(topics.length)this.state.set('relayPushTopics',JSON.stringify(topics));else this.store.db.prepare("DELETE FROM settings WHERE key='relayPushTopics'").run();
        this.registered=true;this.retry=0;this.emit('status','connected');
      }else if(message.type==='push-result'){
        const pending=typeof message.id==='string'&&this.pushes.get(message.id);if(!pending)return;
        this.pushes.delete(message.id);pending.resolve({ok:message.ok===true,status:Number(message.status)||0,reason:typeof message.reason==='string'?message.reason.slice(0,100):''});
      }else if(message.type==='request'){
        if(this.inflight>=8 || this.inflightBytes+data.length>64_000_000){this.reject(ws,message.route);return;}
        this.inflight++;this.inflightBytes+=data.length;
        try{await this.handle(ws,message);}finally{this.inflight--;this.inflightBytes-=data.length;}
      }
    });
    ws.on('close',()=>{
      clearInterval(heartbeat);
      if(generation===this.generation){this.registered=false;for(const [id,pending] of this.pushes){this.pushes.delete(id);pending.reject(new Error('The relay disconnected before confirming the notification.'));}}
      if(this.stopped || generation!==this.generation)return;
      this.emit('status','reconnecting');
      const delay=Math.min(30_000,500*2**Math.min(this.retry||0,6))+Math.floor(Math.random()*500);this.retry=(this.retry||0)+1;
      this.timer=setTimeout(()=>this.connect(),delay);
    });
  }
  reject(ws,route){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'rejected',route}));}
  async handle(ws,message){
    let credential,request;
    const packet=message.packet;
    try{
      validatePacket(packet);if(packet.host!==this.state.host)throw new Error();
      credential=this.state.credential(packet.channel);if(!credential)throw new Error();
      request=open(credential.secret,packet,'request');
    }catch{this.reject(ws,message.route);return;}
    let response;
    try{
      if(!this.state.receive(packet))throw Object.assign(new Error('Duplicate transport request rejected. Check the session before retrying a command.'),{status:409});
      if(credential.kind==='invite'){
        if(request.op!=='pair')throw new Error('Pairing is required.');
        response={status:200,body:Buffer.from(JSON.stringify(this.state.consume(packet.channel,request.name,request.publicKey))).toString('base64')};
      }else{
        if(!['GET','POST'].includes(request.method) || typeof request.path!=='string' || !relayRoute(request.path) || request.path.includes('#') || request.path.includes('\\') || request.path.length>4096 || typeof request.token!=='string')throw new Error('Invalid request.');
        // Never let an encrypted request turn the desktop into an arbitrary HTTP proxy.
        const url=new URL(request.path,this.apiURL);if(url.origin!==new URL(this.apiURL).origin)throw new Error('Invalid destination.');
        const res=await fetch(url,{method:request.method,headers:{'Authorization':`Bearer ${request.token}`,...(request.body===undefined?{}:{'Content-Type':'application/json'})},...(request.body===undefined?{}:{body:JSON.stringify(request.body)}),redirect:'error',signal:AbortSignal.timeout(45_000)}).catch(error=>{
          // The phone cannot act on "fetch failed"; keep the detail here and tell it what happened.
          console.error(`Relay request ${request.method} ${url.pathname} failed: ${error.message}`);
          throw Object.assign(new Error(error.name==='TimeoutError'?'Your Mac took too long to answer. Check the conversation, then try again.':'Agent Remote on your Mac isn\'t responding. Open Agent Remote on the Mac, then try again.'),{status:error.name==='TimeoutError'?504:502});
        });
        const body=Buffer.from(await res.arrayBuffer());
        if(body.length>28_000_000)throw Object.assign(new Error('This file is too large to send in one piece. Update the Agent Remote app to download it in parts.'),{status:413});
        response={status:res.status,body:body.toString('base64')};
      }
    }catch(error){response={status:error.status||400,body:Buffer.from(JSON.stringify({error:error.message})).toString('base64')};}
    try{
      const encrypted=seal(credential.secret,packet,response,'response');
      if(ws.readyState===WebSocket.OPEN && ws.bufferedAmount<MAX_PACKET_BYTES)ws.send(JSON.stringify({type:'response',route:message.route,packet:encrypted}));
    }catch{this.reject(ws,message.route);}
  }
  close(){this.stopped=true;++this.generation;this.registered=false;clearTimeout(this.timer);this.socket?.terminate();for(const [id,pending] of this.pushes){this.pushes.delete(id);pending.reject(new Error('Agent Remote is shutting down.'));}}
}
