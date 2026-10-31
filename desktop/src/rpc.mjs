import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class RPC extends EventEmitter {
  constructor(command, args) {
    super(); this.pending = new Map(); this.counter = 0;
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Never put provider logs or credentials on the public API.
    createInterface({ input: this.child.stdout }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.method) { this.emit('notification', value); return; }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(value.id);
      if (value.error) pending.reject(Object.assign(new Error(value.error.message),{code:value.error.code,...value.error.data})); else pending.resolve(value.result);
    });
    const fail = error => {
      this.dead = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.emit('disconnect', error);
    };
    this.child.on('error', fail);
    this.child.on('exit', () => fail(new Error('Codex connection closed.')));
    this.child.stdin.on('error', () => {});
  }
  send(value) { if (!this.dead) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  call(method, params = {}) {
    if (this.dead) return Promise.reject(new Error('Codex is disconnected.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; its outcome may be unknown.`)); }, 25_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'agent_remote', title: 'Agent Remote', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }
  close() { this.child.kill(); }
}

// Local TCP app-server transport used by both the native terminal and phone adapter.
export class WebSocketRPC extends EventEmitter {
  constructor(endpoint, token) {
    super(); this.pending=new Map(); this.counter=0;
    this.ws=new WebSocket(endpoint,{handshakeTimeout:10000,maxPayload:32*1024*1024,...(token?{headers:{Authorization:'Bearer '+token}}:{})});
    this.ready=new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject);});this.ready.catch(()=>{});
    this.ws.on('message',data=>{
      let value;try{value=JSON.parse(data.toString());}catch{return;}
      if(value.method){this.emit('notification',value);return;}
      const pending=this.pending.get(value.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(value.id);
      if(value.error)pending.reject(Object.assign(new Error(value.error.message),{code:value.error.code,...value.error.data}));else pending.resolve(value.result);
    });
    const fail=error=>{this.dead=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('disconnect',error);};
    this.ws.on('error',fail);this.ws.on('close',()=>fail(new Error('Codex connection closed.')));
  }
  send(value){if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(value));}
  call(method,params={}){return RPC.prototype.call.call(this,method,params);}
  async initialize(){await this.ready;await RPC.prototype.initialize.call(this);}
  close(){this.ws.terminate();}
}
