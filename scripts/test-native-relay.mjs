import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createQuestion,questionAnswer,resolveQuestion} from '../desktop/src/questions.mjs';
import {Store} from '../desktop/src/store.mjs';
import {RelayState} from '../desktop/src/relay-state.mjs';
import {DesktopRelay} from '../desktop/src/relay-client.mjs';
import {createServer} from '../desktop/src/server.mjs';
import {createRelay} from '../relay/src/server.mjs';
const directory=mkdtempSync(join(tmpdir(),'agentremote-native-'));
const store=new Store(directory);const state=new RelayState(store);
let sends=0;
const providers={answer:async(id,qid,answers)=>{const value=questionAnswer(store,id,qid,answers);if(!value.duplicate)resolveQuestion(store,value.question,value.answers);return {ok:true};},remove:async id=>store.deleteSession(id),stop:async id=>store.save({...store.session(id),status:"ended"}),discover:async()=>({sessions:store.sessions(),warnings:[]}),history:async()=>{},status:()=>{},send:async(id,body)=>{sends++;store.message(id,{id:'reply',role:'assistant',kind:'text',text:'NATIVE_REPLY'});store.save({...store.session(id),status:'idle'});createQuestion(store,id,[{title:'Which metric?',options:['Customer','Revenue']}]);}};
store.save({id:'codex:fixture',provider:'codex',status:'idle',control:'managed',title:'Native fixture',updatedAt:Date.now(),cwd:directory});
store.save({id:'memory:fixture',provider:'claude',status:'ended'});store.message('memory:fixture',{id:'memory-message',role:'user',kind:'text',text:'I use Hex for analytics.'});store.memory.apply(store.memory.batch('memory:fixture'),{facts:[{topic:'work/analytics',text:'I use Hex for analytics.',sourceMessage:'memory-message',quote:'I use Hex for analytics.',kind:'fact'}]});
const external=process.env.AGENT_REMOTE_TEST_RELAY;
const relay=external?null:createRelay();
if(relay)await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));
state.configure(external || `ws://127.0.0.1:${relay.server.address().port}`);
const {server}=createServer({store,providers});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const desktop=new DesktopRelay({store,state,apiURL:`http://127.0.0.1:${server.address().port}`});
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Connection timeout')),10_000);desktop.on('status',status=>{if(status==='connected'){clearTimeout(timer);resolve();}});desktop.start();});
  const inviteFile=join(directory,'invite');writeFileSync(inviteFile,state.invite().uri,{mode:0o600});
  const child=spawn(resolve('build/native-relay-smoke'),[inviteFile],{stdio:['ignore','inherit','inherit']});
  const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  if(code!==0 || sends!==1)throw new Error(`Native test failed (exit ${code}; submitted ${sends} times).`);
}finally{desktop.close();await relay?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});}
