import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {Providers,tailJSON,removeClaudeHistory,codexRolloutMessages,expandHome} from '../src/providers.mjs';
function fixture(t,provider='codex') {
  const dir=mkdtempSync(join(tmpdir(),'agentremote-provider-'));const store=new Store(dir);const providers=new Providers(store);providers.discoverClaude=async()=>{};
  const session={id:`${provider}:test`,provider,providerId:'test',status:'idle',cwd:dir,control:'managed'};store.save(session);
  t.after(()=>{providers.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,providers,session,dir};
}
test('Codex streaming and completed items converge to one message',t=>{
  const {store,providers,session}=fixture(t);const rpc={send:()=>{}};
  providers.codexEvent(rpc,{method:'turn/started',params:{threadId:'test',turn:{id:'turn'}}});
  providers.codexEvent(rpc,{method:'item/agentMessage/delta',params:{threadId:'test',itemId:'message',delta:'Hello '}});
  providers.codexEvent(rpc,{method:'item/agentMessage/delta',params:{threadId:'test',itemId:'message',delta:'world'}});
  providers.codexEvent(rpc,{method:'item/completed',params:{threadId:'test',item:{id:'message',type:'agentMessage',text:'Hello world'}}});
  providers.codexEvent(rpc,{method:'turn/completed',params:{threadId:'test',turn:{id:'turn',status:'completed'}}});
  assert.equal(store.messages(session.id).length,1);assert.equal(store.messages(session.id)[0].text,'Hello world');assert.equal(store.session(session.id).status,'idle');
});
test('Claude partial messages converge with completed tool and assistant messages',t=>{
  const {store,providers,session}=fixture(t,'claude');
  providers.claudeEvent(session,{type:'stream_event',event:{type:'message_start',message:{id:'m'}}});
  providers.claudeEvent(session,{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello'}}});
  providers.claudeEvent(session,{type:'assistant',message:{id:'m',content:[{type:'text',text:'Hello there'},{type:'tool_use',id:'t',name:'Bash',input:{command:'pwd'}}]}});
  assert.equal(store.messages(session.id).length,2);assert.equal(store.messages(session.id)[0].text,'Hello there');assert.equal(store.messages(session.id)[1].role,'tool');
});
test('live external Claude sessions reject control instead of silently forking',async t=>{
  const {store,providers,session}=fixture(t,'claude');store.save({...session,control:'external-live',note:'Exit original session first.'});
  await assert.rejects(providers.send(session.id,{text:'hello'}),/Exit original/);
  await assert.rejects(providers.stop(session.id),/original Claude client/);
});
test('partially written transcript records do not break discovery',t=>{
  const {dir}=fixture(t);const path=join(dir,'transcript.jsonl');writeFileSync(path,'{"type":"user"}\n{"unfinished":');
  assert.deepEqual(tailJSON(path),[{type:'user'}]);
});

test('a folder typed as ~ means the home folder, and a missing folder says what to do',async t=>{
  const {providers,dir}=fixture(t,'claude');
  assert.equal(expandHome('~'),homedir());assert.equal(expandHome('~/src'),join(homedir(),'src'));assert.equal(expandHome('~other/src'),'~other/src');
  assert.equal((await providers.create({provider:'claude',cwd:' ~ '})).cwd,homedir());
  assert.equal((await providers.create({provider:'claude',cwd:''})).cwd,homedir());
  await assert.rejects(providers.create({provider:'claude',cwd:'~/agent-remote-missing-folder-test'}),e=>e.status===400&&e.message==="The folder ~/agent-remote-missing-folder-test doesn't exist on this Mac. Check the path, or leave it blank to use your home folder.");
  writeFileSync(join(dir,'note.txt'),'x');await assert.rejects(providers.create({provider:'claude',cwd:join(dir,'note.txt')}),/is a file, not a folder/);
});
test('a missing agent CLI reads as not installed and never becomes a list warning',async t=>{
  const {store,providers,session}=fixture(t,'claude');const saved={codex:process.env.AGENT_REMOTE_CODEX,claude:process.env.AGENT_REMOTE_CLAUDE};
  t.after(()=>{for(const [k,v] of Object.entries(saved)){const key='AGENT_REMOTE_'+k.toUpperCase();if(v===undefined)delete process.env[key];else process.env[key]=v;}});
  process.env.AGENT_REMOTE_CODEX='agent-remote-missing-codex';process.env.AGENT_REMOTE_CLAUDE='agent-remote-missing-claude';
  await assert.rejects(providers.create({provider:'codex'}),{message:"Codex isn't installed on this Mac. Open Agent Remote on the Mac and click Install Codex."});
  delete providers.discoverClaude;assert.deepEqual((await providers.discover()).warnings,[]);
  const child=providers.startClaude(session);await once(child,'error');
  assert.equal(store.messages(session.id).at(-1).text,"Claude Code isn't installed on this Mac. Open Agent Remote on the Mac and click Install Claude.");assert.equal(store.session(session.id).status,'error');
});
test('new sessions inherit saved model defaults and accept per-session overrides',async t=>{
  const {store,providers,dir}=fixture(t);
  store.setModelDefaults({codex:'custom-codex',claude:'custom-claude',local:'local-model',localProvider:'lmstudio'});
  const calls=[];providers.codex=async()=>({call:async(method,params)=>{calls.push({method,params});return {thread:{id:String(calls.length)}};}});
  const claude=await providers.create({provider:'claude',cwd:dir});assert.equal(claude.model,'custom-claude');
  await providers.create({provider:'codex',cwd:dir});assert.equal(calls.at(-1).params.model,'custom-codex');
  await providers.create({provider:'codex',cwd:dir,model:'override'});assert.equal(calls.at(-1).params.model,'override');
  await providers.create({provider:'local',cwd:dir});assert.equal(calls.at(-1).params.model,'local-model');assert.equal(calls.at(-1).params.modelProvider,'lmstudio');
  store.setModelDefaults({codex:'',claude:'',local:'',localProvider:'ollama'});
  await providers.create({provider:'codex',cwd:dir});assert.equal('model' in calls.at(-1).params,false);
});
test('ending clears stale turn IDs and delayed completion does not reopen session',async t=>{
  const {store,providers,session}=fixture(t);const methods=[];
  store.save({...session,turnId:'completed-turn'});
  providers.codex=async()=>({call:async(method)=>{methods.push(method);return {thread:{status:{type:'idle'}}};}});
  await providers.stop(session.id,true);
  assert.equal(methods.includes('turn/interrupt'),false);assert.ok(methods.includes('thread/unsubscribe'));
  providers.codexEvent({}, {method:'turn/completed',params:{threadId:'test',turn:{status:'completed'}}});
  assert.equal(store.session(session.id).status,'ended');assert.equal(store.session(session.id).turnId,null);
});
test('deletion uses provider permanent delete, rejects concurrent control, and retains history on failure',async t=>{
  const {store,providers,session}=fixture(t);
  store.message(session.id,{id:'m',text:'keep until deleted'});
  providers.busy.add(session.id);await assert.rejects(providers.remove(session.id),/operation in progress/);providers.busy.clear();
  providers.codex=async()=>({call:async(method)=>{if(method==='thread/delete')throw new Error('provider refused');return {thread:{status:{type:'idle'}}};}});
  await assert.rejects(providers.remove(session.id),/provider refused/);assert.equal(store.messages(session.id).length,1);
  const methods=[];providers.codex=async()=>({call:async(method)=>{methods.push(method);return {thread:{status:{type:'idle'}}};}});
  await providers.remove(session.id);assert.ok(methods.includes('thread/delete'));assert.equal(store.session(session.id),undefined);assert.equal(store.messages(session.id).length,0);
});
test('deleted Codex descendants and late Claude events cannot restore history',t=>{
  const {store,providers,session}=fixture(t,'claude');
  store.deleteSession(session.id);
  providers.claudeEvent(session,{type:'assistant',message:{id:'late',content:'late text'}});
  assert.equal(store.messages(session.id).length,0);
  store.save({id:'codex:child',provider:'codex'});store.message('codex:child',{id:'m',text:'child'});
  providers.codexEvent({}, {method:'thread/deleted',params:{threadId:'child'}});
  assert.equal(store.session('codex:child'),undefined);assert.equal(store.messages('codex:child').length,0);
});
test('Claude deletion removes only the exact session transcript and child history',t=>{
  const {dir}=fixture(t);const root=join(dir,'projects');const project=join(root,'project');mkdirSync(join(project,'target','subagents'),{recursive:true});
  writeFileSync(join(project,'target.jsonl'),'history');writeFileSync(join(project,'target','subagents','agent.jsonl'),'child');
  writeFileSync(join(project,'other.jsonl'),'other');writeFileSync(join(dir,'work.txt'),'working file');
  removeClaudeHistory(root,'target');assert.equal(existsSync(join(project,'target.jsonl')),false);assert.equal(existsSync(join(project,'target')),false);assert.ok(existsSync(join(project,'other.jsonl')));assert.ok(existsSync(join(dir,'work.txt')));
  symlinkSync(join(dir,'work.txt'),join(project,'escape.jsonl'));assert.throws(()=>removeClaudeHistory(root,'escape'),/outside/);assert.throws(()=>removeClaudeHistory(root,'../work'),/Invalid/);assert.ok(existsSync(join(dir,'work.txt')));
});

test('unsupported Codex history falls back to verified local messages without duplicates or injected instructions',async t=>{
 const {providers,store,session,dir}=fixture(t);const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=dir;t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 const path=join(dir,'sessions','rollout.jsonl');mkdirSync(join(dir,'sessions'));
 const rows=[{type:'session_meta',payload:{id:'test'}},
 {type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'private instructions'}]}},
 {type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{turn_id:'auto-compact-0'},content:[{type:'input_text',text:'injected user context'}]}},
 {type:'response_item',payload:{id:'raw-user',type:'message',role:'user',internal_chat_message_metadata_passthrough:{turn_id:'11111111-1111-1111-1111-111111111111'},content:[{type:'input_text',text:'Hello'}]}},
 {type:'response_item',payload:{id:'assistant',type:'message',role:'assistant',content:[{type:'output_text',text:'Hi'}]}}];
 writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 assert.deepEqual(codexRolloutMessages(path,'wrong'),[]);assert.equal(codexRolloutMessages(path,'test').length,2);
 store.message(session.id,{id:'stream-user',role:'user',kind:'text',text:'Hello'});
 const calls=[];const rpc={call:async(method,params)=>{calls.push([method,params]);if(params.includeTurns)throw Error('list_turns is not supported yet');return {thread:{path,status:{type:'idle'}}};}};providers.codex=async()=>rpc;
 await providers.history(session.id);await providers.history(session.id);
 assert.deepEqual(store.messages(session.id).map(m=>m.text),['Hello','Hi']);assert.equal(calls.filter(([m,p])=>p.includeTurns).length,1);assert.equal(calls.filter(([m])=>m==='thread/resume').length,1);
});
test('Codex history still surfaces unrelated provider failures',async t=>{
 const {providers,session}=fixture(t);providers.codex=async()=>({call:async()=>{throw Error('connection lost');}});await assert.rejects(providers.history(session.id),/connection lost/);
});
test('opening a known Claude transcript reads new messages without rescanning other sessions',async t=>{
 const {providers,session,store,dir}=fixture(t,'claude');const transcript=join(dir,'known.jsonl');store.save({...session,transcript});
 providers.discoverClaude=async()=>{throw Error('Global scan must not run');};
 const row={type:'assistant',uuid:'message-1',timestamp:'2026-09-07T10:00:00Z',message:{id:'m1',content:[{type:'text',text:'Live reply'}]}};
 writeFileSync(transcript,JSON.stringify(row)+'\n');await providers.history(session.id);assert.equal(store.messages(session.id)[0].text,'Live reply');
 row.message.id='m2';row.message.content[0].text='Next live reply';row.timestamp='2026-09-07T11:00:00Z';writeFileSync(transcript,JSON.stringify(row)+'\n');await providers.history(session.id);assert.equal(store.messages(session.id).at(-1).text,'Next live reply');
});
test('discovery clears orphaned external running state without disturbing a live client',t=>{
 const {providers,store,session,dir}=fixture(t,'claude');store.save({...session,control:'external-live',status:'running',transcript:join(dir,'gone.jsonl')});
 store.save({id:'claude:live',provider:'claude',providerId:'live',control:'external-live',status:'running'});
 providers.reconcileClaudeActivity([{sessionId:'live'}]);assert.equal(store.session(session.id).status,'ended');assert.equal(store.session(session.id).control,'resume');assert.equal(store.session('claude:live').control,'external-live');assert.equal(store.session('claude:live').status,'running');
});
test('End uses refreshed ownership rather than the stale external-live snapshot',async t=>{
 const {providers,store,session}=fixture(t,'claude');store.save({...session,control:'external-live',status:'running'});
 providers.discoverClaude=async()=>providers.reconcileClaudeActivity([]);await providers.stopProvider(session.id,true);assert.equal(store.session(session.id).status,'ended');
});
test('foreign test workspaces are excluded from discovery while their owning fixture can use them',async t=>{
 const {providers,store,dir}=fixture(t);const cwd=join(dir,'fixture-work');mkdirSync(cwd);writeFileSync(join(cwd,'.agent-remote-test-fixture'),'test');
 assert.equal(providers.isForeignFixture(cwd),true);assert.equal(providers.isForeignFixture(dir),false);
 const own=Object.create(Providers.prototype);const state=join(cwd,'state');mkdirSync(state);own.store={directory:state};assert.equal(own.isForeignFixture(cwd),false);
 providers.codex=async()=>({call:async method=>method==='thread/loaded/list'?{data:[]}:{data:[{id:'test-thread',cwd,updatedAt:1}]}});await providers.discover();assert.equal(store.session('codex:test-thread'),undefined);
});

test('ephemeral history failures preserve cached messages without disabling durable history',async t=>{
 const {providers,store,session}=fixture(t);let ephemeral=true;let listCalls=0;
 store.message(session.id,{id:'cached',role:'assistant',kind:'text',text:'Existing reply'});
 const rpc={call:async(method,params)=>{
  if(method==='thread/resume')return {};
  if(method==='thread/turns/list'){listCalls++;throw Error('ephemeral threads do not support thread/turns/list');}
  if(params.includeTurns && ephemeral)throw Error('Use paginated history');
  return {thread:{name:'Original title',status:{type:'idle'},turns:ephemeral?[]:[{items:[{id:'durable',type:'agentMessage',text:'Durable reply'}]}]}};
 }};providers.codex=async()=>rpc;
 await providers.history(session.id);await providers.history(session.id);
 assert.equal(listCalls,1);assert.equal(rpc.historyUnavailable,undefined);
 assert.equal(store.messages(session.id)[0].text,'Existing reply');assert.equal(store.session(session.id).title,'Original title');
 ephemeral=false;store.save({id:'codex:durable',provider:'codex',providerId:'durable',status:'idle'});
 await providers.history('codex:durable');assert.equal(store.messages('codex:durable')[0].text,'Durable reply');
});
test('direct ephemeral history errors fall back without requesting persisted turns',async t=>{
 const {providers,session}=fixture(t);const rpc={call:async(method,params)=>{
  assert.notEqual(method,'thread/turns/list');
  if(params.includeTurns)throw Error('ephemeral threads do not support thread/turns/list');
  return {thread:{ephemeral:true,status:{type:'notLoaded'}}};
 }};providers.codex=async()=>rpc;assert.deepEqual(await providers.history(session.id),[]);
});
test('temporary bootstrap threads do not appear as conversations and native titles replace placeholders',t=>{
 const {providers,store,session}=fixture(t);providers.codexHost={};
 providers.codexEvent({}, {method:'thread/started',params:{thread:{id:'temporary',ephemeral:true}}});
 assert.equal(store.session('codex:temporary'),undefined);
 store.save({...session,title:'Codex terminal session'});
 providers.codexEvent({}, {method:'thread/started',params:{thread:{id:'test',name:'Build AgentRemote'}}});
 assert.equal(store.session(session.id).title,'Build AgentRemote');
 providers.codexEvent({}, {method:'thread/started',params:{thread:{id:'test',preview:''}}});
 assert.equal(store.session(session.id).title,'Build AgentRemote');
 providers.codexHost=undefined;
});
test('discovery preserves useful titles when thread metadata is sparse',async t=>{
 const {providers,store,session}=fixture(t);store.save({...session,title:'Build AgentRemote'});
 providers.codex=async()=>({call:async method=>({data:method==='thread/loaded/list'?['test']:[{id:'test',name:null,preview:'',updatedAt:1},{id:'temporary',ephemeral:true,updatedAt:1}]})});
 await providers.discover();assert.equal(store.session(session.id).title,'Build AgentRemote');assert.equal(store.session('codex:temporary'),undefined);
});

test('Claude synthetic resume placeholder is removed on replay while genuine replies remain',t=>{
 const {store,providers,session}=fixture(t,'claude');
 store.message(session.id,{id:'placeholder:0',role:'assistant',kind:'text',text:'No response requested.'});
 providers.claudeEvent(session,{type:'assistant',message:{id:'placeholder',model:'<synthetic>',content:[{type:'text',text:'No response requested.'}]}});
 assert.equal(store.messages(session.id).length,0);
 providers.claudeEvent(session,{type:'assistant',message:{id:'real',model:'claude',content:[{type:'text',text:'No response requested.'}]}});
 assert.equal(store.messages(session.id).length,1);
});
test('Claude transcript split blocks finish the matching streamed block',t=>{
 const {store,providers,session}=fixture(t,'claude');
 store.append(session.id,'reply:1','Finished');
 providers.claudeEvent(session,{type:'assistant',apiBlockIndex:0,message:{id:'reply',content:[{type:'thinking',thinking:''}]}});
 providers.claudeEvent(session,{type:'assistant',apiBlockIndex:1,timestamp:'2026-09-09T11:17:46.467Z',message:{id:'reply',content:[{type:'text',text:'Finished'}]}});
 const messages=store.messages(session.id);assert.equal(messages.length,1);assert.equal(messages[0].partial,false);assert.equal(messages[0].id,'reply:1');
});

test('live Claude split blocks without apiBlockIndex finish the streamed block behind thinking',t=>{
 const {store,providers,session}=fixture(t,'claude');
 const stream=e=>providers.claudeEvent(session,{type:'stream_event',event:e},true);
 // Shape observed from `claude -p --output-format stream-json --include-partial-messages` (2.1.267): the finished
 // block arrives before its content_block_stop and carries no apiBlockIndex.
 stream({type:'message_start',message:{id:'reply'}});
 stream({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
 providers.claudeEvent(session,{type:'assistant',uuid:'u0',timestamp:'2026-09-17T22:53:50.443Z',message:{id:'reply',content:[{type:'thinking',thinking:''}]}},true);
 stream({type:'content_block_stop',index:0});
 stream({type:'content_block_start',index:1,content_block:{type:'text',text:''}});
 stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Fini'}});
 stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'shed'}});
 providers.claudeEvent(session,{type:'assistant',uuid:'u1',timestamp:'2026-09-17T22:54:02.500Z',message:{id:'reply',content:[{type:'text',text:'Finished'}]}},true);
 stream({type:'content_block_stop',index:1});
 stream({type:'content_block_start',index:2,content_block:{type:'tool_use',id:'t',name:'Bash',input:{}}});
 providers.claudeEvent(session,{type:'assistant',uuid:'u2',message:{id:'reply',content:[{type:'tool_use',id:'t',name:'Bash',input:{command:'pwd'}}]}},true);
 stream({type:'content_block_stop',index:2});
 const messages=store.messages(session.id);
 assert.deepEqual(messages.map(m=>[m.id,m.kind,m.partial]),[['reply:1','text',false],['reply:2','tool_use',false]]);
 assert.equal(messages[0].text,'Finished');assert.equal(messages[0].completedAt,Date.parse('2026-09-17T22:54:02.500Z'));
 // The next API message starts its own block numbering.
 stream({type:'message_start',message:{id:'reply2'}});
 stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
 stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Done'}});
 providers.claudeEvent(session,{type:'assistant',uuid:'u3',message:{id:'reply2',content:[{type:'text',text:'Done'}]}},true);
 assert.deepEqual(store.messages(session.id).map(m=>[m.id,m.partial]),[['reply:1',false],['reply:2',false],['reply2:0',false]]);
});
test('a finished reply removes a streamed copy stored under another block index',t=>{
 const {store,providers,session}=fixture(t,'claude');
 store.append(session.id,'reply:1','Same words');
 store.append(session.id,'other:1','Same words');
 providers.claudeEvent(session,{type:'assistant',message:{id:'reply',content:[{type:'text',text:'Same words'}]}},true);
 const messages=store.messages(session.id);
 assert.deepEqual(messages.map(m=>[m.id,m.partial]),[['other:1',true],['reply:0',false]]);
});

test('long prompts still submit: context recall is bounded and can never block a message',async t=>{
  const {store,providers,session}=fixture(t,'claude');
  const long='Continue the previous work. '+'Decision detail. '.repeat(400); // over 4000 characters, like a service handoff carrying a transcript
  assert.ok(long.length>4000);assert.throws(()=>store.knowledge.search(long),/short query/);
  const written=[];providers.startClaude=s=>{const child={pid:4194304,kill(){},on(){},once(){},settingsRevision:0,stdin:{write:(data,cb)=>{written.push(JSON.parse(data));cb();},on(){},end(){}}};providers.claude.set(s.id,child);return child;};
  await providers.send(session.id,{text:long,requestId:'long'});
  assert.equal(store.session(session.id).status,'running');
  assert.ok(written[0].message.content[0].text.startsWith(long));
});
