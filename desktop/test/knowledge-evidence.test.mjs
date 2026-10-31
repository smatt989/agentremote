import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { importReferenceNotes, evidenceText } from '../src/knowledge-evidence.mjs';
import { MemoryWorker, instruction } from '../src/memory-worker.mjs';
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'knowledge-evidence-'));const store=new Store(join(directory,'state'));store.save({id:'s',provider:'claude',status:'idle',updatedAt:1});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {store,directory};}

test('tool observations and long responses are learned completely within bounded batches',t=>{
 const {store}=fixture(t);const text='Useful dbt definition. '.repeat(1800)+'END OF SOURCE';
 store.message('s',{id:'long',role:'assistant',kind:'text',text});
 store.message('s',{id:'tool',role:'tool',kind:'tool_result',text:JSON.stringify({type:'tool_result',tool_use_id:'call',content:'API uses runtime cell IDs.'})});
 let recovered='',tool=false;
 for(let i=0;i<20;i++) {const b=store.memory.batch('s');if(!b.messages.length)break;assert.ok(b.messages.reduce((n,m)=>n+m.text.length,0)<=24000);for(const m of b.messages){if(m.id==='long')recovered+=m.text;if(m.id==='tool')tool=true;}store.memory.apply(b,{facts:b.messages.filter(m=>m.id==='tool').map(m=>({topic:'tools/hex',text:'API uses runtime cell IDs.',quote:'API uses runtime cell IDs.',sourceMessage:m.id,kind:'fact'}))});}
 assert.equal(recovered,text);assert.equal(tool,true);const fact=store.memory.list()[0];assert.match(fact.trust,/Tool evidence/);assert.equal(fact.expiresAt,null);
});

test('active learning stops at the current turn and resumes after the next user boundary',async t=>{
 const {store}=fixture(t);store.save({...store.session('s'),status:'running',updatedAt:Date.now()});
 for(const m of [{id:'u1',role:'user',text:'Define dbt grain.'},{id:'a1',role:'assistant',text:'One row per customer.'},{id:'u2',role:'user',text:'Now add a chart.'},{id:'a2',role:'assistant',text:'Still streaming',partial:true}])store.message('s',{kind:'text',...m});
 let seen=[];const worker=new MemoryWorker(store.memory,{extract:async b=>{seen.push(...b.messages.map(m=>m.id));return {facts:[]};}});t.after(()=>worker.close());
 await worker.tick();assert.deepEqual(seen,['u1','a1']);await worker.tick();assert.deepEqual(seen,['u1','a1']);
 store.message('s',{id:'a2',role:'assistant',kind:'text',text:'Finished chart',partial:false});store.message('s',{id:'u3',role:'user',kind:'text',text:'Next request'});
 await worker.tick();assert.ok(seen.includes('a2'));assert.ok(!seen.includes('u3'));
});

test('reference notes share searchable evidence, replace edits, remove deleted files, and respect forgetting',t=>{
 const {store,directory}=fixture(t),root=join(directory,'projects'),project=join(root,'encoded'),notes=join(project,'memory');mkdirSync(notes,{recursive:true});
 const session={...store.session('s'),transcript:join(project,'s.jsonl')};store.save(session);
 const path=join(notes,'hex.md');writeFileSync(path,'Hex export IDs differ from API runtime IDs.');
 assert.equal(importReferenceNotes(store.memory,session,root),1);assert.equal(importReferenceNotes(store.memory,session,root),0);
 assert.ok(store.memory.search('runtime').some(f=>f.sourcePath===realpathSync(path)));assert.match(store.knowledge.search('runtime')[0].topic,/references/);
 writeFileSync(path,'Corrected definition: API IDs come from cell list.');assert.equal(importReferenceNotes(store.memory,session,root),1);assert.equal(store.memory.search('runtime').length,0);
 const f=store.memory.list()[0];store.memory.forget(f.id);writeFileSync(path,'Changed again: API IDs are useful.');importReferenceNotes(store.memory,session,root);assert.equal(store.memory.list().length,0);
 const second=join(notes,'dbt.md');writeFileSync(second,'dbt grain is one customer.');importReferenceNotes(store.memory,session,root);rmSync(second);importReferenceNotes(store.memory,session,root);assert.equal(store.memory.list().length,0);
});

test('reference import rejects symlinks and unrelated folders; payloads omit images and recalled memory',t=>{
 const {store,directory}=fixture(t),root=join(directory,'projects'),project=join(root,'p'),notes=join(project,'memory');mkdirSync(notes,{recursive:true});
 const secret=join(directory,'outside.md');writeFileSync(secret,'Not project evidence.');symlinkSync(secret,join(notes,'link.md'));
 assert.equal(importReferenceNotes(store.memory,{...store.session('s'),transcript:join(project,'s.jsonl')},root),0);
 assert.equal(importReferenceNotes(store.memory,{...store.session('s'),transcript:join(directory,'s.jsonl')},root),0);
 assert.doesNotMatch(evidenceText({role:'tool',kind:'tool_result',text:JSON.stringify({type:'tool_result',content:[{type:'image',source:{data:'BASE64'}},{type:'text',text:'Useful result'}]})}),/BASE64/);
 store.message('s',{id:'search',role:'tool',kind:'tool_use',text:JSON.stringify({id:'c',name:'mcp__agent_remote_mac__memory_search',input:{query:'dbt'}})});
 store.message('s',{id:'result',role:'tool',kind:'tool_result',text:JSON.stringify({tool_use_id:'c',content:'Previously recalled claim'})});assert.equal(store.memory.batch('s').messages.length,0);
 assert.equal(evidenceText({role:'tool',kind:'mcpToolCall',text:JSON.stringify({tool:'knowledge_read',result:{text:'Recalled claim'}})}),'');
 assert.match(instruction,/Use progress ONLY/);assert.doesNotMatch(instruction,/Assistant reports are provisional progress/);
});

test('bounded backfill is idempotent and can correct a formerly temporary classification',t=>{
 const {store}=fixture(t);store.message('s',{id:'a',role:'assistant',kind:'text',text:'Hex IDs come from cell list.'});
 const f={topic:'tools/hex',text:'Hex IDs come from cell list.',quote:'Hex IDs come from cell list.',sourceMessage:'a',kind:'progress'};
 store.memory.apply(store.memory.batch('s'),{facts:[f]});store.memory.queueEvidenceBackfill('s');const batch=store.memory.batch('s');assert.equal(batch.messages.length,1);
 store.memory.apply(batch,{facts:[{...f,kind:'fact'}]});assert.equal(store.memory.list()[0].expiresAt,null);
 store.memory.queueEvidenceBackfill('s');assert.equal(store.memory.batch('s').messages.length,0);
});
