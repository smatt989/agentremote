import {spawn} from 'node:child_process';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {WebSocketRPC} from './rpc.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class CodexHost {
  constructor(directory,command){this.directory=directory;this.command=command;}
  async start(){
    const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    this.endpoint='ws://127.0.0.1:'+listener.address().port;await new Promise(r=>listener.close(r));
    this.token=randomBytes(32).toString('base64url');this.tokenPath=join(this.directory,'codex-access-'+process.pid);
    writeFileSync(this.tokenPath,this.token,{mode:0o600});
    this.child=spawn(this.command,['app-server','--listen',this.endpoint,'--ws-auth','capability-token','--ws-token-file',this.tokenPath],{stdio:'ignore'});
    this.child.once('error',e=>{this.error=e;});
    this.child.once('exit',()=>{this.exited=true;});
    try {
      for(let n=0;n<80;n++){
        if(this.error||this.exited)throw this.error||new Error('Codex server exited during startup.');
        const rpc=new WebSocketRPC(this.endpoint,this.token);
        try {await rpc.initialize();this.rpc=rpc;return rpc;}catch(error){rpc.close();if(n===79)throw error;await sleep(100);}
      }
    }catch(error){this.close();throw error;}
  }
  async close(){
    this.rpc?.close();
    const child=this.child;
    if(child && child.exitCode===null && child.signalCode===null){
      await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.once('error',()=>{clearTimeout(timer);resolve();});child.kill();});
    }
    if(this.tokenPath)rmSync(this.tokenPath,{force:true});
  }
}
