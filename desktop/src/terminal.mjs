// Launched by a small shell function; runs the original CLI with its real terminal UI.
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from './store.mjs';
import {filterTerminalInput} from './terminal-input.mjs';
import {terminalCleanup} from './terminal-cleanup.mjs';
import {pickSession,sessionDirectory,resumeArgs} from './terminal-pickup.mjs';
let [provider,command,...args]=process.argv.slice(2);
const sessionList=()=>{const store=new Store();try{return store.sessions();}finally{store.close();}};
// Run from the conversation's own directory; Claude only finds a transcript from its project directory.
const enter=session=>{const cwd=sessionDirectory(session,process.cwd());if(cwd!==process.cwd()){process.chdir(cwd);process.stderr.write('Agent Remote: continuing in '+cwd+'\n');}};
// pickup CLAUDE CODEX [search words]: choose any Agent Remote conversation and continue it here.
if(provider==='pickup'){
 const [claude,codex,...words]=[command,...args];
 if(!process.stdin.isTTY){console.error('Agent Remote: pickup needs an interactive terminal.');process.exit(2);}
 let session;try{session=await pickSession(sessionList(),{query:words.join(' ')});}catch(error){console.error('Agent Remote: '+error.message);process.exit(1);}
 if(!session)process.exit(1);
 provider=session.provider;command=provider==='claude'?claude:codex;args=resumeArgs(session);
 if(!command){console.error('Agent Remote: '+provider+' is not installed in this shell.');process.exit(1);}
 enter(session);
}
if(!['codex','claude'].includes(provider)||!command){console.error('Usage: agent-remote codex|claude /absolute/path/to/cli [arguments]');process.exit(2);}
const maintenance=new Set(['exec','e','review','login','logout','mcp','mcp-server','app-server','remote-control','completion','update','doctor','debug','features','sandbox','queue','delete','archive','unarchive','migrate-rollouts','plugin','app','cloud','exec-server','auth','agents','attach','logs','stop','kill','rm','respawn','install','setup-token','daemon','plugins','ultrareview','self-hosted-runner','gateway','auto-mode','project','import']);
const direct=!process.stdin.isTTY||args.some(a=>['-p','--print','--bg','--background'].includes(a))||args.some(a=>['-h','--help','-V','--version','-v','--remote'].includes(a))||maintenance.has(args.find(a=>!a.startsWith('-')));
async function launch(extra=[],environment={}) {
 const child=spawn(command,[...extra,...args],{stdio:'inherit',env:{...process.env,...environment}});
 child.once('error',e=>{console.error(e.message);process.exitCode=1;});
 // The terminal sends Ctrl-C directly to the CLI too; do not terminate the launcher first.
 const ignore=()=>{};process.on('SIGINT',ignore);
 child.once('exit',(code,signal)=>{process.off('SIGINT',ignore);process.exitCode=code??(signal?130:1);});
}
try {
 if(direct)await launch();
 else {
  const store=new Store();let token,directory;try{token=store.desktopToken();directory=store.directory;}finally{store.close();}
  let status;try{status=JSON.parse(readFileSync(join(directory,'desktop-status.json'),'utf8'));}catch{}
  if(!status||Date.now()-status.updatedAt>10000){
   const opener=spawn('/usr/bin/open',['-g','-a','Agent Remote'],{stdio:'ignore'});opener.on('error',()=>{});
   for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,200));try{status=JSON.parse(readFileSync(join(directory,'desktop-status.json'),'utf8'));if(Date.now()-status.updatedAt<10000)break;}catch{}}
  }
  if(!status||Date.now()-status.updatedAt>10000)throw Error('Open Agent Remote to start remote access, then retry. Use command codex to run without phone access.');
  if(provider==='claude'){
   // claude --resume without a full ID opens the Agent Remote picker (any directory); a known ID moves to its directory.
   const flag=args.findIndex(a=>a==='--resume'||a==='-r');
   if(flag>=0){
    const value=args[flag+1]&&!args[flag+1].startsWith('-')?args[flag+1]:'';
    const session=await pickSession(sessionList(),{query:value,provider:'claude'});
    if(!session)process.exit(1);
    args=[...args.slice(0,flag),'--resume',session.providerId,...args.slice(flag+(value?2:1))];
    enter(session);
   }
   const base='http://127.0.0.1:'+status.port;
   const call=async(path,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error),{status:response.status});return result;};
   // A busy or restarting service must not detach this terminal; only an HTTP answer (ended, gone) is final.
   let outage=false;
   const retry=async work=>{for(let wait=250,since=Date.now();;wait=Math.min(wait*2,2000)){
    try{return await work();}
    catch(e){if(e.status||closed||Date.now()-since>120000)throw e;
     if(!outage&&Date.now()-since>3000){outage=true;process.stderr.write('\r\nAgent Remote: waiting for the service to respond…\r\n');}
     await new Promise(r=>setTimeout(r,wait));}
   }};
   const {id}=await call('/terminal/claude',{command,args,cwd:process.cwd(),env:process.env,cols:process.stdout.columns||80,rows:process.stdout.rows||28});const path='/sessions/'+encodeURIComponent(id)+'/terminal';
   let generation=(await call(path+'/control',{})).generation,seq=0,owner='you',closed=false;
   let inputs=Promise.resolve();
   const resize=()=>{inputs=inputs.then(()=>closed?undefined:call(path+'/input',{resize:{cols:process.stdout.columns||80,rows:process.stdout.rows||28}})).catch(e=>{if(!closed)process.stderr.write('\r\n'+e.message+'\r\n');});};
   process.stdout.on('resize',resize);resize();
   process.stderr.write('Agent Remote shared terminal. Type here or on your phone. Close this tab to detach.\r\n');
   process.stdin.setRawMode(true);process.stdin.resume();
   const restore=terminalCleanup();
   process.once('exit',restore);process.once('SIGHUP',()=>{restore();process.exit(0);});process.once('SIGTERM',()=>{restore();process.exit(0);});
   const stopInput=filterTerminalInput(process.stdin,data=>{inputs=inputs.then(async()=>{
    if(closed)return;
    if(data.includes(29)){generation=(await call(path+'/control',{})).generation;owner='you';return;}
    // xterm queries are answered once by the host emulator, not this observer.
    const cleaned=data.toString();if(!cleaned)return;

    // The same request ID makes a retried keystroke apply at most once.
    const requestId=randomUUID(),bytes=Buffer.from(cleaned).toString('base64');
    await retry(()=>call(path+'/input',{generation,requestId,data:bytes}));
   }).catch(e=>{if(!closed)process.stderr.write('\r\n'+e.message+'\r\n');});});
   // Long poll: the service answers as soon as there is output (an older service answers at once).
   try{while(!closed){const started=Date.now(),frame=await retry(()=>call(path+'?after='+(outage?0:seq)+'&wait=5000'));outage=false;generation=frame.generation;owner=frame.owner;seq=frame.seq;
    if(frame.reset)writeSync(process.stdout.fd,'\x1bc');
    for(const chunk of frame.data.split('.'))if(chunk)writeSync(process.stdout.fd,Buffer.from(chunk,'base64'));
    // Coalesce bursts of output into one paint; only an immediate empty answer (older service) needs the old polling pause.
    closed=frame.ended;if(!closed)await new Promise(r=>setTimeout(r,frame.data?16:Date.now()-started<50?100:0));
   }}finally{closed=true;process.stdout.off('resize',resize);stopInput();process.stdin.pause();process.stdin.removeAllListeners('data');restore();}
   process.exit(0);
  }
  const response=await fetch('http://127.0.0.1:'+status.port+'/terminal/codex',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to connect to Agent Remote.');
  if(!/^ws:\/\/127\.0\.0\.1:\d+$/.test(result.endpoint)||typeof result.token!=='string')throw Error('Invalid local Codex connection.');
  const cwd=args.some(a=>a==='-C'||a==='--cd'||a.startsWith('--cd=')||a.startsWith('-C'))?[]:['-C',process.cwd()];
  await launch(['--remote',result.endpoint,'--remote-auth-token-env','AGENT_REMOTE_CODEX_TOKEN',...cwd],{AGENT_REMOTE_CODEX_TOKEN:result.token});
 }
}catch(error){console.error('Agent Remote: '+error.message);process.exitCode=1;}
