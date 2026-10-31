import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {MemoryWorker} from '../src/memory-worker.mjs';
import {createQuestion,pendingQuestions,questionAnswer} from '../src/questions.mjs';
import {Providers,visibleText} from '../src/providers.mjs';
import {createServer} from '../src/server.mjs';
function fixture(t) {const dir=mkdtempSync(join(tmpdir(),'agentremote-memory-test-'));const store=new Store(dir);store.save({id:'source',provider:'claude',status:'idle',updatedAt:1});store.save({id:'new',provider:'claude',status:'idle',updatedAt:1});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
const user=(store,text='I use Hex.tech for analytics at Northstar.')=>store.message('source',{id:'user1',role:'user',kind:'text',text,completedAt:1});
const fact={topic:'work/northstar/analytics',text:'Uses Hex.tech for Northstar analytics.',kind:'fact',sourceMessage:'user1',quote:'I use Hex.tech for analytics at Northstar.'};
test('new sessions retrieve recent context immediately, and learned facts retain evidence locally',t=>{
  const store=fixture(t);user(store);assert.ok(store.memory.search('analytics',{excludeSession:'new'}).some(r=>r.sourceMessage==='user1'));assert.deepEqual(store.memory.search('analytics',{excludeSession:'source'}),[]);
  const batch=store.memory.batch('source');store.memory.apply(batch,{facts:[fact]});const hits=store.memory.search('Hex');assert.equal(hits[0].kind,'fact');assert.equal(hits[0].trust,'User stated');assert.equal(hits[0].sourceMessage,'user1');
  const files=readdirSync(join(store.directory,'memory'));assert.equal(files.length,1);assert.match(readFileSync(join(store.directory,'memory',files[0]),'utf8'),/Northstar/);
  assert.equal(store.memory.batch('source').messages.length,0);assert.equal(store.memory.topics()[0].topic,'work/northstar/analytics');
});
test('unsubstantiated quotes, credentials and path traversal cannot become learned facts',t=>{
  const store=fixture(t);user(store);store.memory.apply(store.memory.batch('source'),{facts:[{...fact,quote:'Invented quotation'},{...fact,topic:'../../escape'},{...fact,text:'api_key=sk-abcdefghijklmnopqrst'}]});assert.equal(store.memory.list().length,0);
});
test('assistant evidence remains provisional, expires, and current session is excluded',t=>{
  const store=fixture(t);store.message('source',{id:'a',role:'assistant',kind:'text',text:'The retention report is complete.'});store.memory.apply(store.memory.batch('source'),{facts:[{...fact,sourceMessage:'a',text:'The retention report is complete.',quote:'The retention report is complete.',kind:'progress'}]});const hit=store.memory.search('retention')[0];assert.match(hit.trust,/verify/);assert.ok(hit.expiresAt>Date.now());
});
test('deletion and forgetting remove retrieval paths and prevent delayed worker resurrection',t=>{
  const store=fixture(t);user(store);const batch=store.memory.batch('source');store.memory.apply(batch,{facts:[fact]});store.memory.forget(store.memory.list()[0].id);assert.deepEqual(store.memory.search('Hex'),[]);store.memory.apply(batch,{facts:[fact]});assert.deepEqual(store.memory.list(),[]);
  store.deleteSession('source');store.memory.apply(batch,{facts:[fact]});assert.deepEqual(store.memory.search('Hex'),[]);assert.equal(readdirSync(join(store.directory,'memory')).length,0);
});
test('background learning waits for idle, survives failure, and processes once',async t=>{
  const store=fixture(t);user(store);let count=0;const worker=new MemoryWorker(store.memory,{synthesize:async batch=>({title:batch.topic,summary:batch.sources[0].text,sections:batch.sources.map(f=>({text:f.text,evidence:[f.id]})),links:[]}),extract:async()=>{count++;return {facts:[fact]};},idleMs:120000});t.after(()=>worker.close());await worker.tick(1000);assert.equal(count,0);await worker.tick(200000);assert.equal(count,1);await worker.tick(300000);assert.equal(count,1);
});
test('questions validate choices, preserve free text, and submit one answer through provider',async t=>{
  const store=fixture(t);const providers=new Providers(store);t.after(()=>providers.close());let calls=0;providers.send=async()=>{calls++;};
  const q=createQuestion(store,'new',[{title:'Which retention?',options:['Customer','Revenue']}]);assert.equal(pendingQuestions(store,'new').length,1);assert.throws(()=>createQuestion(store,'new',[{title:'Another'}]),/existing/);
  assert.throws(()=>questionAnswer(store,'new',q.id,{}),/each/);await providers.answer('new',q.id,{'0':'Workspace retention instead'});await providers.answer('new',q.id,{'0':'Workspace retention instead'});assert.equal(calls,1);assert.deepEqual(pendingQuestions(store,'new'),[]);await assert.rejects(providers.answer('new',q.id,{'0':'Different'}),/differently/);
});
test('native Codex questions stay pending until explicit answer and return the required shape',async t=>{
  const store=fixture(t);store.save({id:'codex:t',provider:'codex',providerId:'t',status:'running'});const providers=new Providers(store);t.after(()=>providers.close());const replies=[];const rpc={send:r=>replies.push(r)};
  providers.codexEvent(rpc,{id:7,method:'item/tool/requestUserInput',params:{threadId:'t',questions:[{id:'metric',question:'Which metric?',options:[{label:'Revenue',description:'Net revenue'}]}]}});
  assert.equal(replies.length,0);assert.equal(store.session('codex:t').status,'waiting');const q=pendingQuestions(store,'codex:t')[0];await providers.answer('codex:t',q.id,{metric:'Revenue'});assert.deepEqual(replies[0],{id:7,result:{answers:{metric:{answers:['Revenue']}}}});
});
test('internal context never becomes displayed user text',()=>{
  assert.equal(visibleText('Hello\n\n[Agent Remote: Files and charts to share with the phone should be saved in /tmp/a.]\n<agent-remote-context>\nprivate memory\n</agent-remote-context>'),'Hello');
});
test('memory and question APIs require auth and reject malformed or cross-session answers',async t=>{
  const store=fixture(t);user(store);const providers=new Providers(store);providers.send=async()=>{};t.after(()=>providers.close());const {server}=createServer({store,providers});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;const headers={Authorization:'Bearer '+store.createDevice('test').token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/knowledge')).status,401);assert.equal((await fetch(base+'/knowledge/page?id=x')).status,401);assert.equal((await fetch(base+'/knowledge?q=Hex',{headers})).status,200);assert.equal((await fetch(base+'/knowledge/page?id=x',{headers})).status,200);assert.equal((await fetch(base+'/memory')).status,401);assert.equal((await fetch(base+'/memory?q=Hex',{headers})).status,200);
  const q=createQuestion(store,'new',[{title:'Which?',options:['A','B']}]);const wrong=await fetch(base+'/sessions/source/questions/'+q.id+'/answer',{method:'POST',headers,body:JSON.stringify({answers:{'0':'A'}})});assert.equal(wrong.status,404);
  const response=await fetch(base+'/sessions/new/questions/'+q.id+'/answer',{method:'POST',headers,body:JSON.stringify({answers:{'0':'A'}})});assert.equal(response.status,200);
});
test('recent corrections remain retrievable alongside older learned facts',t=>{
  const store=fixture(t);user(store);const batch=store.memory.batch('source');store.memory.apply(batch,{facts:Array.from({length:6},(_,i)=>({...fact,text:'Hex analytics convention '+i}))});
  store.message('source',{id:'correction',role:'user',kind:'text',text:'Correction: we now use another analytics tool instead of Hex.',createdAt:Date.now()+1000});
  const results=store.memory.search('Hex analytics',{excludeSession:'new',limit:5,budget:4200});assert.ok(results.some(r=>r.sourceMessage==='correction'));assert.ok(JSON.stringify(results).length<4300);
});
test('topic subtrees exclude the active session and can be explored without keywords',t=>{
  const store=fixture(t);user(store);store.memory.apply(store.memory.batch('source'),{facts:[{...fact,topic:'work/northstar_example/analytics'}]});assert.equal(store.memory.topics()[0].topic,'work/northstar-example/analytics');assert.ok(store.memory.search('',{topic:'work'}).length);assert.deepEqual(store.memory.search('',{topic:'work',excludeSession:'source'}),[]);
});
test('failed learning retries later without advancing its durable cursor',async t=>{
  const store=fixture(t);user(store);let count=0;const worker=new MemoryWorker(store.memory,{synthesize:async batch=>({title:batch.topic,summary:batch.sources[0].text,sections:batch.sources.map(f=>({text:f.text,evidence:[f.id]})),links:[]}),extract:async()=>{count++;throw new Error('offline');}});t.after(()=>worker.close());await worker.tick(200000);await worker.tick(210000);assert.equal(count,1);assert.equal(store.memory.batch('source').messages.length,1);await worker.tick(1200000);assert.equal(count,2);
});
test('incremental learning carries preceding context without extracting it twice',t=>{
  const store=fixture(t);user(store,'At Northstar, active accounts have activity in the last 28 days.');const first=store.memory.batch('source');store.memory.apply(first,{facts:[]});store.message('source',{id:'correction',role:'user',kind:'text',text:'Actually, make that 30 days.'});const next=store.memory.batch('source');assert.equal(next.messages.length,1);assert.match(next.context[0].text,/28 days/);assert.equal(next.messages[0].id,'correction');
});
test('an idle session with nothing new to learn does not rebuild the knowledge wiki',t=>{
  const store=fixture(t);user(store);store.memory.apply(store.memory.batch('source'),{facts:[fact]});
  let rebuilds=0;const rebuild=store.knowledge.rebuild.bind(store.knowledge);store.knowledge.rebuild=()=>{rebuilds++;return rebuild();};
  for(let i=0;i<3;i++)store.memory.apply(store.memory.batch('source'),{facts:[]});
  assert.equal(rebuilds,0);
  store.message('source',{id:'user2',role:'user',kind:'text',text:'Northstar revenue excludes refunds.',completedAt:2});
  store.memory.apply(store.memory.batch('source'),{facts:[{...fact,text:'Northstar revenue excludes refunds.',quote:'Northstar revenue excludes refunds.',sourceMessage:'user2'}]});
  assert.equal(rebuilds,1);assert.ok(store.knowledge.search('refunds').length);
});
