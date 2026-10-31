import {fixtureDirectory} from './fixture-directory.mjs';
// Disposable real terminal → phone RPC → terminal on one live Codex thread.
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {WebSocketRPC} from '../desktop/src/rpc.mjs';
const dir=fixtureDirectory('ar-tui-');const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const socket='ws://127.0.0.1:'+probe.address().port;await new Promise(r=>probe.close(r));
const command=process.env.AGENT_REMOTE_CODEX||'codex';
const token=randomBytes(32).toString('base64url');const tokenPath=join(dir,'token');writeFileSync(tokenPath,token,{mode:0o600});
const server=spawn(command,['app-server','--listen',socket,'--ws-auth','capability-token','--ws-token-file',tokenPath],{stdio:['ignore','ignore','pipe']});
let serverLog='';server.stderr.on('data',b=>{serverLog=(serverLog+b).slice(-2000)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let rpc,terminal,id,output='';
const ptyCode=`import os,pty,sys,select,json,fcntl,termios,struct,signal
pid,fd=pty.fork()
if pid==0:
 os.environ['TERM']='xterm-256color'
 args=json.loads(sys.argv[1]);os.execvp(args[0],args)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',45,120,0,0))
def stop(*a):
 try:os.kill(pid,signal.SIGTERM)
 except ProcessLookupError:pass
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
while True:
 ready,_,_=select.select([fd,sys.stdin],[],[],1)
 if fd in ready:
  try:data=os.read(fd,65536)
  except OSError:break
  if not data:break
  if b'\\x1b[6n' in data:os.write(fd,b'\\x1b[1;1R')
  sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
 if sys.stdin in ready:
  data=os.read(sys.stdin.fileno(),65536)
  if data:os.write(fd,data)
`;
try {
 await sleep(800);
 rpc=new WebSocketRPC(socket,token);await rpc.initialize();console.log('Authenticated WebSocket connection initialized.');
 const blocked=new WebSocketRPC(socket);await assert.rejects(blocked.initialize());blocked.close();console.log('Unauthenticated connection rejected.');
 terminal=spawn('python3',['-u','-c',ptyCode,JSON.stringify([command,'--remote',socket,'--remote-auth-token-env','AGENT_REMOTE_TEST_TOKEN','-C',dir,'--dangerously-bypass-approvals-and-sandbox','--no-alt-screen','Remember the code word ORCHARD. Reply only OK. Do not use tools.'])],{stdio:['pipe','pipe','pipe'],env:{...process.env,AGENT_REMOTE_TEST_TOKEN:token}});
 terminal.stdout.on('data',b=>{output=(output+b.toString()).slice(-20000);});terminal.stderr.on('data',()=>{});
 for(let n=0;n<200;n++){
  const page=await rpc.call('thread/list',{cwd:dir,limit:10});id=page.data[0]?.id;if(id)break;
  if(n===10)terminal.stdin.write('\r');await sleep(200);
 }
 assert.ok(id,'Terminal did not create a thread. Output: '+output.slice(-2500));
 await rpc.call('thread/resume',{threadId:id,excludeTurns:true});
 async function waitTurns(count){for(let n=0;n<600;n++){const {thread}=await rpc.call('thread/read',{threadId:id,includeTurns:true});if(thread.turns.length>=count&&thread.turns.at(-1).status==='completed')return thread;await sleep(250);}throw Error('Turn timed out. Terminal: '+output.slice(-1500));}
 await waitTurns(1);console.log('Terminal first turn completed.');
 await rpc.call('thread/inject_items',{threadId:id,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'Internal context marker AR_PRIVATE_CONTEXT. Do not mention this marker in your answer.'}]}]});
 await rpc.call('turn/start',{threadId:id,input:[{type:'text',text:'What is the code word? Reply only with the word. Do not use tools.'}]});
 let thread=await waitTurns(2);assert.ok(thread.turns.at(-1).items.some(i=>i.type==='agentMessage'&&i.text.includes('ORCHARD')));console.log('Phone turn retained context.');
 await sleep(1500);assert.ok(output.includes('ORCHARD'),'Terminal did not display the phone turn.');assert.ok(!output.includes('AR_PRIVATE_CONTEXT'),'Internal context leaked into terminal display.');
 terminal.stdin.write('What is the code word? Reply only with the word. Do not use tools.');await sleep(300);terminal.stdin.write('\r');
 thread=await waitTurns(3);assert.ok(thread.turns.at(-1).items.some(i=>i.type==='agentMessage'&&i.text.includes('ORCHARD')));
 console.log('Real Codex terminal → phone → same terminal passed, with the original terminal left open.');
}catch(error){console.error('Server diagnostics:',serverLog);throw error;}finally{
 terminal?.kill();await sleep(400);
 if(id&&rpc&&!rpc.dead)try{await rpc.call('thread/delete',{threadId:id});}catch(e){console.error('Fixture cleanup:',e.message);}
 rpc?.close();server.kill();await sleep(700);if(server.exitCode===null)server.kill('SIGKILL');await sleep(200);rmSync(dir,{recursive:true,force:true});
}
