import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
const fail=message=>Object.assign(Error(message),{status:409});
export class ClaudeTerminal {
 static create(options){return new ClaudeTerminal(options);}
 constructor({command,args,cwd,env,cols=80,rows=28,helper=process.env.AGENT_REMOTE_PTY || fileURLToPath(new URL('../../TerminalHost',import.meta.url)),onExit=()=>{}}) {
  this.startedAt=Date.now();this.owner='desktop';this.generation=1;this.seq=0;this.chunks=[];this.bytes=0;this.requests=new Map();this.ended=false;this.waiters=new Set();
  const size=terminalSize(cols,rows);
  this.screen=new headless.Terminal({...size,scrollback:500,allowProposedApi:true});
  this.serializer=new serialize.SerializeAddon();this.screen.loadAddon(this.serializer);
  this.child=spawn(helper,[cwd,command,...args],{stdio:['pipe','pipe','ignore','pipe'],env:{...(env||process.env),AGENT_REMOTE_COLS:String(size.cols),AGENT_REMOTE_ROWS:String(size.rows)}});
  this.child.stdin.on('error',()=>{});this.child.stdio[3].on('error',()=>{});
  // Only the host answers terminal queries; observers must never echo replies.
  this.screen.onData(data=>{if(!this.ended)this.child.stdin.write(data);});
  this.pending=Promise.resolve();
  this.child.stdout.on('data',data=>{
   this.pending=this.pending.then(()=>new Promise(resolve=>this.screen.write(new Uint8Array(data),()=>{
    this.chunks.push({seq:++this.seq,data:data.toString('base64')});this.bytes+=data.length;
    while(this.bytes>524288&&this.chunks.length>1){this.bytes-=Buffer.from(this.chunks.shift().data,'base64').length;}this.wake();resolve();
   })));
  });
  this.done=new Promise(resolve=>{let finished=false;const finish=()=>{if(finished)return;finished=true;this.ended=true;this.wake();onExit();resolve();};this.child.once('error',finish);this.child.once('exit',finish);});
 }
 wake(){for(const waiter of [...this.waiters])waiter();}
 // A viewer that is already current may wait for the next output (long poll) so typed keys echo without a polling delay.
 async read(after=0,{wait=0}={}) {
  if(wait>0&&after>0&&after===this.seq&&!this.ended)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.waiters.delete(done);resolve();};const timer=setTimeout(done,Math.min(wait,10000));this.waiters.add(done);});
  await this.pending;
  const reset=after===0||after<(this.resizedAt||-1)||after>this.seq||after<(this.chunks[0]?.seq||1)-1;
  return {sharedInput:true,inputRevision:this.inputRevision||0,seq:this.seq,reset,data:reset?Buffer.from(this.serializer.serialize()).toString('base64'):this.chunks.filter(c=>c.seq>after).map(c=>c.data).join('.'),owner:this.owner,generation:this.generation,ended:this.ended,cols:this.screen.cols,rows:this.screen.rows};
 }
 // Screen rows for verification-based automation, after pending output is rendered.
 async lines(){await this.pending;const b=this.screen.buffer.active;return Array.from({length:this.screen.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');}
 // Raw keys from Agent Remote itself (question cards). Bumps the input revision so a
 // phone prompt prepared against the earlier screen is rejected instead of mixed in.
 write(bytes){
  if(this.ended)throw fail('This terminal has ended.');
  if(this.submittingPrompt)throw fail('A message is being submitted to this terminal. Try again shortly.');
  this.inputRevision=(this.inputRevision||0)+1;this.lastInputAt=Date.now();this.child.stdin.write(bytes);
 }
 // Retained for older phones; this no longer excludes another device.
 control(owner){if(this.ended)throw fail('This terminal has ended.');return {owner,generation:this.generation};}
 resize(cols,rows) {
  const size=terminalSize(cols,rows);
  if(this.ended)throw fail('This terminal has ended.');
  if(size.cols===this.screen.cols&&size.rows===this.screen.rows)return {ok:true};
  // Older live helpers predate the resize pipe. Preserve their processes during
  // an app update by resizing only the verified immediate child's slave PTY.
  let legacyTTY;
  if(!this.child.stdio?.[3]){
   const children=execFileSync('/bin/ps',['-axo','pid=,ppid=,tty='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/)).filter(p=>Number(p[1])===this.child.pid);
   if(children.length!==1||!/^ttys[0-9]+$/.test(children[0][2]))throw fail('Unable to identify this terminal for resizing.');
   legacyTTY='/dev/'+children[0][2];
  }
  this.pending=this.pending.then(()=>{
   this.screen.resize(size.cols,size.rows);
   this.resizedAt=++this.seq;this.wake();
   if(legacyTTY)execFileSync('/bin/stty',['-f',legacyTTY,'cols',String(size.cols),'rows',String(size.rows)]);
   else this.child.stdio[3].write(`${size.cols} ${size.rows}\n`);
  });
  return {ok:true};
 }
 input({owner,generation,requestId,data,prompt,inputRevision,resize}) {
  if(resize!==undefined){if(owner!=='desktop')throw fail('Only the desktop terminal can change its size.');return this.resize(resize.cols,resize.rows);}
  const isPrompt=typeof prompt==='string';
  if(typeof requestId!=='string'||requestId.length>100||(isPrompt?(!prompt.trim()||prompt.length>50000):(typeof data!=='string'||data.length>100000||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))))throw fail('Invalid terminal input.');
  const digest=createHash('sha256').update(JSON.stringify({owner,...(isPrompt?{prompt,inputRevision}:{data})})).digest('hex');
  if(this.requests.has(requestId)){if(this.requests.get(requestId)!==digest)throw fail('Input ID already used.');return {ok:true,duplicate:true};}
  if(this.ended)throw fail('This terminal has ended.');
  if(this.requests.size>=100000)throw fail('Terminal input limit reached. End and resume this session.');
  if(owner==='desktop')this.desktopInputAt=Date.now();
  if(isPrompt && (this.submittingPrompt || Date.now()-(this.lastInputAt||0)<250 || (this.inputRevision||0)!==inputRevision || !terminalPromptReady(this.screen)))throw fail(terminalBlocked(this.screen));
  this.inputRevision=(this.inputRevision||0)+1;this.lastInputAt=Date.now();
  this.requests.set(requestId,digest);
  if(isPrompt){
   this.prompts ||= new Map();this.prompts.set(requestId,{id:requestId,text:prompt.replaceAll('\x1b',''),createdAt:Date.now()});
   this.submittingPrompt=true;this.deferredInput=[];
   this.child.stdin.write('\x1b[200~'+prompt.replaceAll('\x1b','')+'\x1b[201~');
   setTimeout(()=>{if(!this.ended){this.child.stdin.write('\r');for(const bytes of this.deferredInput)this.child.stdin.write(bytes);}this.deferredInput=[];this.submittingPrompt=false;},180);
  }else if(this.submittingPrompt)this.deferredInput.push(Buffer.from(data,'base64'));
  else this.child.stdin.write(Buffer.from(data,'base64'));
  return {ok:true};
 }
 async close(){if(this.ended)return;this.child.kill('SIGTERM');await this.done;}
}
export function claudeLaunch(args) {
 const flag=args.findIndex(a=>['--resume','-r','--session-id'].includes(a));
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(args.some(a=>['--continue','-c','--fork-session'].includes(a)) || args.some(a=>a.startsWith('--resume=')||a.startsWith('--session-id=')))throw fail('For shared terminal access, resume with claude --resume followed by the full session ID.');
 if(flag>=0){if(!uuid.test(args[flag+1]||''))throw fail('Shared terminal resume needs a full session ID. Use command claude for the interactive session picker.');return {uuid:args[flag+1],args};}
 const id=randomUUID();return {uuid:id,args:['--session-id',id,...args]};
}

export function terminalPromptReady(screen){
 const b=screen.buffer.active;const line=b.getLine(b.baseY+b.cursorY);const text=line?.translateToString(true)||'';
 const prefix=text.match(/^\s*\u276f\s*/)?.[0];if(!prefix)return false;
 // Claude paints placeholder/suggested input dimly and leaves the cursor at
 // the empty input position. It is not part of the editable draft.
 const dimOnly=(line,start=0)=>{
  for(let x=start;x<(line?.length||screen.cols||80);x++){const cell=line?.getCell(x);if(cell?.getChars().trim()&&!cell.isDim())return false;}
  return true;
 };
 const suggestion=text.slice(prefix.length).trim().length>0;
 if(suggestion && (b.cursorX!==prefix.length || !dimOnly(line,prefix.length)))return false;
 for(let y=b.cursorY+1;y<screen.rows;y++){
  const next=b.getLine(b.baseY+y),below=next?.translateToString(true)||'';
  if(/^\s*[-\u2500\u2501]{3,}/.test(below))break;
  if(below.trim() && !(suggestion&&next.isWrapped&&dimOnly(next)))return false;
 }
 return true;
}

// Why a prompt cannot be sent right now. Claude's own dialogs (folder trust after a
// restart, permission and selection prompts) look like a non-empty input, so name them
// instead of reporting a draft nobody typed.
export function terminalBlocked(screen){
 const b=screen.buffer.active;const lines=Array.from({length:screen.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');
 const where='Answer the card in this chat (or use Terminal controls in its menu), then send again.';
 if(lines.some(l=>/trust this folder/i.test(l)))return 'Claude on your Mac is asking whether to trust this folder. '+where;
 if(lines.some(l=>/Enter to (confirm|select)|Esc to (cancel|exit)/i.test(l)))return 'Claude on your Mac is waiting on a prompt. '+where;
 return 'The terminal input changed or has a draft. Check Terminal controls in this chat\'s menu before sending.';
}

export function terminalSize(cols,rows){if(!Number.isInteger(cols)||cols<2||cols>1000||!Number.isInteger(rows)||rows<2||rows>500)throw fail('Invalid terminal dimensions.');return {cols,rows};}
