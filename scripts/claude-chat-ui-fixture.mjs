import {fixtureDirectory} from './fixture-directory.mjs';
import {terminalPromptReady} from '../desktop/src/claude-terminal.mjs';
// Disposable real Claude session for the native phone chat UI test.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';import {Store} from '../desktop/src/store.mjs';import {createServer} from '../desktop/src/server.mjs';
const config=process.argv[2];if(!config)throw Error('Fixture config path required');
const dir=fixtureDirectory('ar-chat-ui-');process.env.AGENT_REMOTE_PTY=resolve('build/TerminalHost');const store=new Store(join(dir,'state'));const {server,providers}=createServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));let id,closing=false;
async function close(){if(closing)return;closing=true;clearTimeout(deadline);if(id)await providers.remove(id).catch(()=>{});await providers.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});process.exit();}
const deadline=setTimeout(close,300000);process.on('SIGTERM',close);process.on('SIGINT',close);
try{
 ({id}=await providers.startTerminal({command:process.env.AGENT_REMOTE_CLAUDE||'claude',args:['--dangerously-skip-permissions'],cwd:dir}));const t=providers.terminals.get(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const plain=()=>{const b=t.screen.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n');};
 const input=text=>t.input({owner:'desktop',generation:t.generation,requestId:randomUUID(),data:Buffer.from(text).toString('base64')});
 let trusted=false;
 for(let n=0;n<200;n++){
  if(terminalPromptReady(t.screen))break;
  if(!trusted&&/Yes, I trust this folder/.test(plain())){
   await sleep(1200);await t.pending;
   const visible=()=>{const b=t.screen.buffer.active;return Array.from({length:t.screen.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'').join('\n');};
   if(/❯\s*No, exit/.test(visible())){input('\x1b[B');await sleep(500);await t.pending;}
   if(!/❯\s*Yes, I trust this folder/.test(visible()))throw Error('Fixture trust option was not selected');
   input('\r');trusted=true;await sleep(1000);
  }
  await sleep(200);
 }
 if(!terminalPromptReady(t.screen))throw Error('Fixture did not reach the native input prompt');
 await sleep(400);
 input('\x1b[200~Remember the code word ORCHARD. Reply only FIRST_OK. Do not use tools.\x1b[201~');await sleep(200);input('\r');
 for(let n=0;n<300;n++){if((plain().match(/FIRST_OK/g)||[]).length>=2)break;await sleep(200);}
 await providers.history(id);if(!store.messages(id).some(m=>m.role==='assistant'&&m.text.includes('FIRST_OK')))throw Error('Fixture initial turn did not complete');
 await sleep(2500);
 const phone=store.createDevice('Disposable UI fixture');writeFileSync(config,JSON.stringify({id,token:phone.token,url:'http://127.0.0.1:'+server.address().port}),{mode:0o600});
 console.log('Disposable Claude conversation ready for native UI test');
}catch(e){console.error(e.message);const t=providers.terminals.get(id);if(t){const b=t.screen.buffer.active;console.error(Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n').slice(-2500));}await close();}
