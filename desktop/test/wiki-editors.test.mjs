import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryWorker } from '../src/memory-worker.mjs';
import { stewardDraft, runEditor } from '../src/wiki-editors.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'agentremote-editors-'));const store=new Store(dir);store.save({id:'s',provider:'claude',status:'idle',updatedAt:1});
  for(const scope of ['work/example','work/another','references'])store.db.prepare('INSERT INTO settings VALUES(?,?)').run('wiki-organized:'+scope,'1');
  // Curation and the librarian are exercised explicitly; keep them out of scheduler tests unless asked.
  for(const scope of ['work/example','work/another'])store.db.prepare('INSERT INTO settings VALUES(?,?)').run('wiki-curated:'+scope,JSON.stringify({at:Date.now(),signature:''}));
  store.db.prepare("INSERT INTO settings VALUES('wiki-librarian',?)").run(JSON.stringify({at:Date.now(),subjects:0}));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}
function add(store,id,text,topic='work/example/revenue',kind='fact',role='user') {store.message('s',{id,role,kind:'text',text});store.memory.apply(store.memory.batch('s'),{facts:[{topic,text,quote:text,sourceMessage:id,kind}]});}
// Routing is the planner's job; these tests treat every claim as already routed.
const routed=store=>{store.knowledge.refresh();for(const {id} of store.db.prepare('SELECT id FROM wiki_claims').all())store.knowledge.markPlanned(id);};
const steward=(store,id)=>{routed(store);return store.knowledge.stewardBatch(store.db.prepare('SELECT * FROM wiki_articles WHERE id=?').get(id));};
const blank={reason:'',summaryChange:'none',summary:'',edits:[],sections:[],links:[],removals:[],handoffs:[],corrections:[],verify:[],threads:[],replies:[]};
const write=batch=>({...blank,decision:'rewrite',summaryChange:'material',summary:'How revenue is defined.',sections:batch.sources.filter(f=>!f.sourceArticle).map(f=>({heading:'',text:f.text,evidence:[f.id]}))});
const publish=(store,id)=>{const b=steward(store,id);assert.equal(store.knowledge.apply(b,write(b)),true);return b;};
const claimFor=(store,text)=>store.db.prepare('SELECT id FROM wiki_claims WHERE text=?').get(text).id;

test('a steward that finds nothing new clears the queue without a revision or queueing the overview',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');publish(store,'work/example/revenue~1');
  const parent=steward(store,'work/example~1');store.knowledge.apply(parent,{...write(parent),summary:'Example overview.',sections:parent.sources.map(f=>({heading:'',text:'See revenue.',evidence:[f.id]}))});
  const before=store.db.prepare('SELECT count(*) n FROM wiki_revisions').get().n;
  add(store,'b','Revenue excludes refunds.');// a repeat observation: same claim, new evidence
  const batch=steward(store,'work/example/revenue~1');assert.ok(batch.sources.some(f=>f.new));
  assert.equal(store.knowledge.apply(batch,{...blank,decision:'none'}),true);
  assert.equal(store.knowledge.read('work/example/revenue~1').pending,false);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wiki_revisions').get().n,before);
  assert.equal(store.knowledge.read('work/example~1').pending,false);
  assert.equal(steward(store,'work/example/revenue~1').sources.some(f=>f.new),false);
});

test('only a material summary change queues the parent overview',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');publish(store,'work/example/revenue~1');
  const parent=steward(store,'work/example~1');store.knowledge.apply(parent,{...write(parent),summary:'Example overview.',sections:parent.sources.map(f=>({heading:'',text:'See revenue.',evidence:[f.id]}))});
  add(store,'b','Revenue is measured per billing account.');
  let batch=steward(store,'work/example/revenue~1');
  store.knowledge.apply(batch,{...blank,decision:'edit',summaryChange:'minor',summary:'How revenue is defined, per account.',edits:[{op:'insert',section:-1,heading:'Grain',text:'Revenue is measured per billing account.',evidence:[batch.sources.find(f=>f.new).id]}]});
  assert.equal(store.knowledge.read('work/example~1').pending,false);
  const article=store.knowledge.read('work/example/revenue~1');assert.match(article.markdown,/billing account/);assert.match(article.markdown,/excludes refunds/);
  add(store,'c','Revenue now includes refunds issued within 7 days.');
  batch=steward(store,'work/example/revenue~1');
  store.knowledge.apply(batch,{...blank,decision:'edit',summaryChange:'material',summary:'Revenue definitions changed in October.',edits:[{op:'insert',section:0,heading:'Refunds',text:'Refunds within 7 days count.',evidence:[batch.sources.find(f=>f.new).id]}]});
  assert.equal(store.knowledge.read('work/example~1').pending,true);
  const revision=JSON.parse(store.db.prepare('SELECT data FROM wiki_revisions WHERE article=? ORDER BY revision DESC LIMIT 1').get('work/example/revenue~1').data);
  assert.equal(revision.edit.decision,'edit');
});

test('cited claims cannot disappear silently; justified removals are recorded on the talk page',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Revenue is reported weekly.');publish(store,'work/example/revenue~1');
  add(store,'c','Revenue is reported monthly since October.');
  const batch=steward(store,'work/example/revenue~1');const keep=batch.previous.sections.find(s=>/refunds/.test(s.text));
  const dropWeekly={...blank,decision:'rewrite',summary:'Revenue.',sections:[keep,{heading:'Reporting',text:'Monthly since October.',evidence:[batch.sources.find(f=>f.new).id]}]};
  assert.throws(()=>store.knowledge.apply(batch,dropWeekly),/no longer cited/);
  const weekly=claimFor(store,'Revenue is reported weekly.');
  assert.equal(store.knowledge.apply(batch,{...dropWeekly,removals:[{claim:weekly,reason:'Superseded by monthly reporting.'}]}),true);
  const talk=store.knowledge.talk('work/example/revenue~1');assert.ok(talk.threads.some(t=>t.kind==='removal'&&t.claims.includes('Revenue is reported weekly.')));
  assert.match(store.knowledge.read('work/example/revenue~1').markdown,/reported weekly/);// still in Sources
});

test('stewardDraft applies edits by index and keeps untouched sections verbatim',()=>{
  const previous={title:'T',summary:'S',synthesized:true,links:[],sections:[{heading:'A',text:'a',evidence:['e1']},{heading:'B',text:'b',evidence:['e2']},{heading:'C',text:'c',evidence:['e3']}]};
  const batch={previous,sources:['e1','e2','e3','e4'].map((id,i)=>({id,claim:'c'+i})),claims:[0,1,2,3].map(i=>({id:'c'+i,status:'current'})),catalog:[]};
  const draft=stewardDraft(batch,{...blank,decision:'edit',edits:[{op:'replace',section:1,heading:'B2',text:'b2',evidence:['e2','e4']},{op:'insert',section:0,heading:'Z',text:'z',evidence:['e4']}]});
  assert.deepEqual(draft.errors,[]);assert.deepEqual(draft.data.sections.map(s=>s.heading),['Z','A','B2','C']);
  assert.match(stewardDraft(batch,{...blank,decision:'edit',edits:[{op:'delete',section:2}]}).errors.join(),/c2/);
  assert.match(stewardDraft(batch,{...blank,decision:'edit',edits:[{op:'replace',section:9,heading:'',text:'x',evidence:['e1']}]}).errors.join(),/existing section/);
  assert.match(stewardDraft({...batch,previous:{...previous,synthesized:false,sections:[]}},{...blank,decision:'none'}).errors.join(),/rewrite/);
});

test('handoffs move a claim with its citations, and a bounced claim goes to the curator instead',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Orders join accounts on account_id.');add(store,'c','Orders have one row per line item.','work/example/orders');
  publish(store,'work/example/revenue~1');publish(store,'work/example/orders~1');
  const joins=claimFor(store,'Orders join accounts on account_id.');let batch=steward(store,'work/example/revenue~1');
  const keep=batch.previous.sections.filter(s=>!s.text.includes('Orders'));
  store.knowledge.apply(batch,{...blank,decision:'edit',edits:batch.previous.sections.map((s,i)=>s.text.includes('Orders')?{op:'delete',section:i}:null).filter(Boolean),handoffs:[{claim:joins,to:'work/example/orders~1',reason:'Join rules belong with orders.'}]});
  assert.doesNotMatch(store.knowledge.read('work/example/revenue~1').markdown,/account_id/);
  assert.match(store.knowledge.read('work/example/orders~1').markdown,/account_id/);
  assert.ok(store.knowledge.talk('work/example/orders~1').threads.some(t=>t.kind==='handoff'));
  assert.equal(keep.length,1);
  batch=steward(store,'work/example/orders~1');
  store.knowledge.apply(batch,{...blank,decision:'none',handoffs:[{claim:joins,to:'work/example/revenue~1',reason:'Actually revenue.'}]});
  assert.ok(store.db.prepare('SELECT 1 FROM wiki_membership WHERE article=? AND claim=?').get('work/example/orders~1',joins));
  assert.ok(store.knowledge.talk('work/example/orders~1').threads.some(t=>t.kind==='misplaced-evidence'&&t.status==='open'));
});

test('declined proposals stay settled until their evidence changes, and repeats join the open thread',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Orders have one row per line item.','work/example/orders');
  const k=store.knowledge;k.refresh();
  const post=()=>k.transaction(()=>k.talkPost({article:'work/example/orders~1',kind:'merge-proposal',title:'Merge',text:'These overlap.',target:'work/example/revenue~1',role:'librarian'}));
  const first=post();assert.equal(post(),first);assert.equal(k.talk('work/example/orders~1').threads[0].posts.length,2);
  k.transaction(()=>k.talkReply(first,{role:'curator',decision:'declined',text:'Different subjects.'}));
  assert.equal(post(),null);
  add(store,'c','Orders exclude test accounts.','work/example/orders');
  assert.ok(post());
});

test('curator merges carry talk and prose to the surviving article; claim moves keep the rest of the prose',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Tools include dbt.','work/example/tools');add(store,'c','Tooling includes Hex.','work/example/tooling');add(store,'d','Hex is the BI tool.','work/example/tooling');
  for(const id of ['work/example/revenue~1','work/example/tools~1','work/example/tooling~1'])publish(store,id);
  const k=store.knowledge;const thread=k.transaction(()=>k.talkPost({article:'work/example/tooling~1',kind:'merge-proposal',title:'Duplicate',text:'Same subject as Tools.',target:'work/example/tools~1',role:'librarian'}));
  store.db.prepare("DELETE FROM settings WHERE key='wiki-curated:work/example'").run();routed(store);
  const batch=k.nextCuration(new Set());assert.equal(batch.type,'curate');assert.equal(batch.threads[0].id,thread);
  const hex=claimFor(store,'Hex is the BI tool.');
  k.apply(batch,{replies:[{thread,decision:'accepted',text:'Merged.'}],creates:[],renames:[{id:'work/example/tools~1',title:'Example tools',summary:'Tools used at Example.',kind:'article',aliases:[],reason:'Natural title.'}],moves:[],merges:[{from:'work/example/tooling~1',into:'work/example/tools~1',reason:'Same subject.'}],claimMoves:[],threads:[],notes:''});
  assert.equal(k.resolve('work/example/tooling~1'),'work/example/tools~1');
  const talk=k.talk('work/example/tools~1');assert.ok(talk.threads.some(t=>t.kind==='merged'&&t.status==='open'));assert.ok(talk.threads.some(t=>t.kind==='merge-proposal'&&t.status==='accepted'));
  assert.ok(store.db.prepare('SELECT aliases FROM wiki_subjects WHERE id=?').get('work/example/tools~1').aliases.includes('Tools'));
  const s=steward(store,'work/example/tools~1');assert.ok(s.talk.some(t=>t.kind==='merged'&&t.prose?.sections.length));
  const again=k.next(new Set(['work/example/tools~1','work/example/revenue~1','work/example~1']));
  k.apply(k.curatorBatch('work/example'),{replies:[],creates:[{id:'work/example/bi~1',title:'BI',summary:'Business intelligence.',kind:'article',parent:'work/example~1',aliases:[],reason:'Split BI out.'}],renames:[],moves:[],merges:[],claimMoves:[{from:'work/example/tools~1',into:'work/example/bi~1',claims:[hex],reason:'BI is its own subject.'}],threads:[],notes:''});
  assert.ok(store.db.prepare('SELECT 1 FROM wiki_membership WHERE article=? AND claim=?').get('work/example/bi~1',hex));
  assert.match(k.read('work/example/tools~1').markdown,/dbt/);
  void again;
});

test('the verifier records file-verified evidence only when its quote is really in the file',t=>{
  const store=fixture(t);const root=realpathSync(mkdtempSync(join(tmpdir(),'agentremote-verify-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  process.env.AGENT_REMOTE_VERIFY_ROOTS=root;t.after(()=>delete process.env.AGENT_REMOTE_VERIFY_ROOTS);
  const file=join(root,'config.mjs');writeFileSync(file,"export const defaultModel = 'claude-opus-5-5';\nexport const retries = 3;\n");
  add(store,'a','The default model is claude-opus-5-5.','work/example/setup','fact','assistant');add(store,'b','Retries happen 5 times.','work/example/setup','fact','assistant');
  publish(store,'work/example/setup~1');const k=store.knowledge;
  const model=claimFor(store,'The default model is claude-opus-5-5.'),retries=claimFor(store,'Retries happen 5 times.');
  let batch=steward(store,'work/example/setup~1');k.apply(batch,{...blank,decision:'none',verify:[{claim:model,hint:root},{claim:retries,hint:root}]});
  routed(store);batch=k.next(new Set(['work/example~1']));assert.equal(batch.type,'verify');
  const forModel=batch.claim.id===model?batch:null;assert.ok(forModel);
  k.apply(batch,{outcome:'confirmed',path:file,quote:"export const defaultModel = 'claude-opus-4';",statement:'',notes:''});
  assert.equal(k.claimStanding(model).verified,false);
  assert.ok(k.talk('work/example/setup~1').threads.some(t=>t.kind==='needs-verification'&&t.status==='declined'));
  const again=()=>k.transaction(()=>k.talkPost({article:'work/example/setup~1',kind:'needs-verification',title:'Again',text:root,claims:[model],role:'steward'}));
  assert.equal(again(),null);// settled until the claim's evidence changes
  add(store,'c','The default model is claude-opus-5-5.','work/example/setup','fact','assistant');routed(store);assert.ok(again());
  const queued=new Set();batch=k.nextVerification(queued);while(batch.claim.id!==model){queued.add(batch.id);batch=k.nextVerification(queued);}
  k.apply(batch,{outcome:'confirmed',path:file,quote:"export const defaultModel = 'claude-opus-5-5';",statement:'',notes:'Constant in config.'});
  assert.equal(k.claimStanding(model).verified,true);assert.equal(k.claimStanding(model).rank,4);
  batch=k.nextVerification(new Set());assert.equal(batch.claim.id,retries);
  k.apply(batch,{outcome:'contradicted',path:file,quote:'export const retries = 3;',statement:'Retries happen 3 times.',notes:''});
  assert.equal(store.db.prepare('SELECT status FROM wiki_claims WHERE id=?').get(retries).status,'superseded');
  assert.ok(store.db.prepare('SELECT 1 FROM wiki_membership m JOIN wiki_claims c ON c.id=m.claim WHERE m.article=? AND c.text=?').get('work/example/setup~1','Retries happen 3 times.'));
  // The file changes: the verification goes stale and is queued again.
  writeFileSync(file,"export const defaultModel = 'claude-fable-5-1';\n");store.db.prepare("UPDATE memory_facts SET data=json_set(data,'$.verifiedMtime',0) WHERE session='wiki-verifier'").run();
  k.transaction(()=>k.checkVerifications());assert.equal(k.claimStanding(model).verified,false);
  assert.ok(store.db.prepare("SELECT 1 FROM wiki_talk WHERE kind='needs-verification' AND status='open'").get());
  // Forgetting the conversation source removes evidence derived from it.
  const original=store.memory.list().find(f=>f.text==='Retries happen 5 times.'&&f.sourceSession==='s');store.memory.forget(original.id);k.refresh();
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_facts WHERE session='wiki-verifier' AND json_extract(data,'$.text')='Retries happen 3 times.'").get().n,0);
});

test('an expiring progress note strips its citation without wiping the article or its ancestors',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','The revenue backfill is half done.','work/example/revenue','progress');
  publish(store,'work/example/revenue~1');
  const parent=steward(store,'work/example~1');store.knowledge.apply(parent,{...write(parent),summary:'Example overview.',sections:parent.sources.map(f=>({heading:'',text:'See revenue.',evidence:[f.id]}))});
  const revisions=store.db.prepare('SELECT count(*) n FROM wiki_revisions').get().n;
  const note=store.memory.list().find(f=>f.kind==='progress');note.expiresAt=1;store.db.prepare('UPDATE memory_facts SET data=? WHERE id=?').run(JSON.stringify(note),note.id);
  const article=store.knowledge.read('work/example/revenue~1');assert.match(article.markdown,/excludes refunds/);assert.doesNotMatch(article.markdown,/half done/);
  assert.equal(store.knowledge.read('work/example~1').synthesized,true);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wiki_revisions').get().n,revisions);
});

test('a reader comment becomes user-stated evidence on that article and calls its steward',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.','work/example/revenue','fact','assistant');publish(store,'work/example/revenue~1');
  const k=store.knowledge;k.comment('work/example/revenue~1','Revenue includes refunds after 7 days.');
  const evidence=k.evidenceFor('work/example/revenue~1');assert.ok(evidence.some(f=>f.trust==='User stated'&&/7 days/.test(f.text)));
  assert.ok(k.stewardCandidates().some(r=>r.id==='work/example/revenue~1'));
  assert.equal(k.talk('work/example/revenue~1').threads[0].kind,'comment');
  assert.throws(()=>k.comment('work/example/revenue~1','token sk-ant-api03-'+'x'.repeat(40)),/credentials/);
});

test('session agents can raise issues but not flood a talk page',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');publish(store,'work/example/revenue~1');const k=store.knowledge;
  for(let i=0;i<12;i++)k.discuss({article:'work/example/revenue~1',kind:'note',text:'Issue '+i,session:'agent'});
  assert.equal(k.discuss({article:'work/example/revenue~1',kind:'note',text:'Issue 3',session:'other'}),k.talk('work/example/revenue~1').threads.find(t=>t.title==='Issue 3').id);
  assert.throws(()=>k.discuss({article:'work/example/revenue~1',kind:'note',text:'One more',session:'agent'}),/many open/);
  assert.throws(()=>k.discuss({article:'work/example/revenue~1',kind:'needs-verification',text:'x',session:'other'}),/Unsupported/);
  assert.equal(k.read('work/example/revenue~1').talk.open,12);
});

test('the scheduler runs freshness reviews after two weeks and the librarian weekly',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Orders exist.','work/example/orders');add(store,'c','Accounts exist.','work/example/accounts');
  for(const id of ['work/example/revenue~1','work/example/orders~1','work/example/accounts~1'])publish(store,id);
  const parent=steward(store,'work/example~1');store.knowledge.apply(parent,{...write(parent),summary:'Example.',sections:parent.sources.map(f=>({heading:'',text:'Overview.',evidence:[f.id]}))});
  const k=store.knowledge;routed(store);assert.equal(k.next(),null);
  store.db.prepare("UPDATE wiki_stewardship SET reviewed=1 WHERE article='work/example/orders~1'").run();
  const review=k.next();assert.equal(review.type,'steward');assert.equal(review.mode,'review');assert.equal(review.id,'work/example/orders~1');
  k.apply(review,{...blank,decision:'none'});
  store.db.prepare("DELETE FROM settings WHERE key='wiki-librarian'").run();
  const librarian=k.next();assert.equal(librarian.type,'librarian');
  k.apply(librarian,{threads:[{article:'work/example/orders~1',kind:'merge-proposal',title:'Overlap',text:'Orders and accounts overlap.',claims:[],target:'work/another/x~1'},{article:'work/example/orders~1',kind:'merge-proposal',title:'Overlap',text:'Orders and accounts overlap.',claims:[],target:'work/example/accounts~1'}],notes:''});
  assert.ok(k.talk('work/example/orders~1').threads.some(t=>t.kind==='merge-proposal'));
  const curate=k.next();assert.equal(curate.type,'curate');assert.equal(curate.scope,'work/example');
});

test('runEditor maps labels and retries a steward that drops a claim',async()=>{
  const batch={type:'steward',id:'work/x~1',mode:'update',today:'2026-10-09',provider:'claude',subject:{id:'work/x~1',title:'X'},
    previous:{title:'X',summary:'S',synthesized:true,links:[],sections:[{heading:'A',text:'a',evidence:['ev-a']}]},
    sources:[{id:'ev-a',claim:'cl-a',text:'a',trust:'User stated',createdAt:1},{id:'ev-b',claim:'cl-b',text:'b',trust:'User stated',createdAt:2,new:true}],
    claims:[{id:'cl-a',text:'a',status:'current'},{id:'cl-b',text:'b',status:'current'}],children:[],talk:[{id:'thread-1',kind:'note',title:'n',claims:[],posts:[]}],decisions:[],catalog:[]};
  const calls=[];
  const extract=async(_b,_t,{payload,instructions})=>{calls.push(payload);
    if(/^Review/.test(instructions))return {approved:true,issues:[]};
    if(!payload.revisionFeedback)return {...blank,decision:'rewrite',summary:'S',sections:[{heading:'B',text:'b',evidence:['s2']}]};
    return {...blank,decision:'edit',edits:[{op:'insert',section:-1,heading:'B',text:'b',evidence:['s2']}],replies:[{thread:'t1',decision:'accepted',text:'Done.'}],verify:[{claim:'c1',hint:'repo'}]};
  };
  const result=await runEditor(batch,{extract});
  assert.match(calls[1].revisionFeedback.join(),/c1/);assert.equal(result.edits[0].evidence[0],'ev-b');assert.equal(result.replies[0].thread,'thread-1');assert.equal(result.verify[0].claim,'cl-a');
});

test('the worker drives stewards end to end',async t=>{
  const store=fixture(t);store.message('s',{id:'m1',role:'user',kind:'text',text:'Revenue excludes refunds.'});
  const worker=new MemoryWorker(store.memory,{extract:async()=>({facts:[{topic:'work/example/revenue',text:'Revenue excludes refunds.',quote:'Revenue excludes refunds.',sourceMessage:'m1',kind:'fact'}]}),synthesize:async batch=>batch.type==='steward'?write(batch):({subjects:[],assignments:batch.claims.map(c=>({claim:c.id,articles:c.articles})),merges:[],corrections:[]})});t.after(()=>worker.close());
  await worker.tick(Date.now()+200000);await worker.tick(Date.now()+230000);await worker.tick(Date.now()+260000);
  assert.equal(store.knowledge.read('work/example/revenue~1').synthesized,true);assert.equal(store.knowledge.read('work/example/revenue~1').pending,false);
});

test('reviewer findings wait for a daily pass and failing stewards back off',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');publish(store,'work/example/revenue~1');
  const parent=steward(store,'work/example~1');store.knowledge.apply(parent,{...write(parent),summary:'Example.',sections:parent.sources.map(f=>({heading:'',text:'Overview.',evidence:[f.id]}))});
  const k=store.knowledge;add(store,'b','Revenue is weekly.');let batch=steward(store,'work/example/revenue~1');
  k.apply(batch,{...blank,decision:'none',preexisting:['Section 0 cites the wrong source.']});
  assert.ok(!k.stewardCandidates().some(r=>r.id==='work/example/revenue~1'));
  store.db.prepare("UPDATE wiki_stewardship SET reviewed=? WHERE article='work/example/revenue~1'").run(Date.now()-2*86400000);
  assert.equal(k.nextReview(new Set())?.id,'work/example/revenue~1');
  add(store,'c','Revenue is reported in USD.');batch=steward(store,'work/example/revenue~1');
  k.reviewFailed(batch,{review:{approved:false,issues:['Unsupported claim.']}});
  assert.ok(!k.stewardCandidates().some(r=>r.id==='work/example/revenue~1'));
  assert.ok(JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='wiki-backoff:work/example/revenue~1'").get().value).until>Date.now());
  store.db.prepare("UPDATE settings SET value=? WHERE key='wiki-backoff:work/example/revenue~1'").run(JSON.stringify({count:1,until:0}));
  batch=steward(store,'work/example/revenue~1');k.apply(batch,{...blank,decision:'edit',edits:[{op:'insert',section:-1,heading:'Currency',text:'USD.',evidence:[batch.sources.find(f=>f.text.includes('USD')).id]}]});
  assert.equal(store.db.prepare("SELECT 1 FROM settings WHERE key='wiki-backoff:work/example/revenue~1'").get(),undefined);
});

test('untouched prose may keep redirected links, and one invalid curator operation does not discard the rest',t=>{
  const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Orders exist.','work/example/orders');add(store,'c','Order lines exist.','work/example/order-lines');add(store,'d','Other revenue rule.','work/another/revenue');
  for(const id of ['work/example/orders~1','work/example/order-lines~1'])publish(store,id);
  let batch=steward(store,'work/example/revenue~1');
  store.knowledge.apply(batch,{...write(batch),sections:[{heading:'',text:'See [[work/example/order-lines~1|order lines]]. Revenue excludes refunds.',evidence:[batch.sources[0].id]}],links:['work/example/order-lines~1']});
  const k=store.knowledge;
  const result=k.apply(k.curatorBatch('work/example'),{replies:[],creates:[],renames:[],moves:[],merges:[{from:'work/example/order-lines~1',into:'work/example/orders~1',reason:'Same subject.'},{from:'work/example~1',into:'work/example/orders~1',reason:'Parent into child.'}],claimMoves:[],threads:[],notes:''});
  assert.equal(result.skipped.length,1);assert.equal(k.resolve('work/example/order-lines~1'),'work/example/orders~1');
  assert.ok(k.talk('work/example~1').threads.some(t=>t.kind==='note'&&/Not applied/.test(t.posts[0].text)));
  add(store,'e','Revenue is weekly.');batch=steward(store,'work/example/revenue~1');
  assert.equal(k.apply(batch,{...blank,decision:'edit',edits:[{op:'insert',section:-1,heading:'Cadence',text:'Weekly.',evidence:[batch.sources.find(f=>f.new).id]}]}),true);
  assert.match(k.read('work/example/revenue~1').markdown,/work%2Fexample%2Forders~1/);
});

test('matching documentation is weaker than verifying code',t=>{
  const store=fixture(t);const root=realpathSync(mkdtempSync(join(tmpdir(),'agentremote-verify-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  process.env.AGENT_REMOTE_VERIFY_ROOTS=root;t.after(()=>delete process.env.AGENT_REMOTE_VERIFY_ROOTS);
  writeFileSync(join(root,'NOTES.md'),'The cache holds 50 entries per user.\n');
  add(store,'a','The cache holds 50 entries.','work/example/setup','fact','assistant');add(store,'b','The cache expires hourly.','work/example/setup','fact','assistant');publish(store,'work/example/setup~1');
  const k=store.knowledge;const size=claimFor(store,'The cache holds 50 entries.'),expiry=claimFor(store,'The cache expires hourly.');
  const batch=steward(store,'work/example/setup~1');k.apply(batch,{...blank,decision:'none',verify:[{claim:size,hint:root},{claim:expiry,hint:root}]});
  let v=k.nextVerification(new Set());if(v.claim.id!==size)v=k.nextVerification(new Set([v.id]));
  k.apply(v,{outcome:'confirmed',path:join(root,'NOTES.md'),quote:'The cache holds 50 entries per user.',statement:'',notes:''});
  assert.equal(k.claimStanding(size).rank,2);assert.match(k.claimStanding(size).trust,/^Consistent with documentation/);
  v=k.nextVerification(new Set());k.apply(v,{outcome:'contradicted',path:join(root,'NOTES.md'),quote:'The cache holds 50 entries per user.',statement:'The cache never expires.',notes:''});
  assert.equal(store.db.prepare('SELECT status FROM wiki_claims WHERE id=?').get(expiry).status,'current');
  assert.ok(k.talk('work/example/setup~1').threads.some(t=>t.kind==='conflict'&&t.status==='open'));
});

test('curators consolidate misfiled content across organizations',t=>{
  const store=fixture(t);add(store,'a','Reset metrics use out-of-case hours.','work/firmware/reset-metrics');add(store,'b','Wear time comes from ha_state_history.','work/firmware/wear-time');add(store,'c','Widgets analytics uses Redshift.','work/widgets/analytics');
  for(const id of ['work/firmware/reset-metrics~1','work/firmware/wear-time~1','work/widgets/analytics~1'])publish(store,id);
  const k=store.knowledge;const wear=claimFor(store,'Wear time comes from ha_state_history.');
  const batch=k.curatorBatch('work/firmware');assert.ok(batch.elsewhere.some(p=>p.id==='work/widgets/analytics~1'));
  const result=k.apply(batch,{replies:[],creates:[],renames:[],moves:[{id:'work/firmware/reset-metrics~1',parent:'work/widgets/analytics~1',reason:'Widgets firmware metrics.'}],merges:[],claimMoves:[{from:'work/firmware/wear-time~1',into:'work/widgets/analytics~1',claims:[wear],reason:'Widgets telemetry.'}],threads:[],notes:''});
  assert.equal(result,true);
  assert.equal(store.db.prepare('SELECT parent FROM wiki_subjects WHERE id=?').get('work/firmware/reset-metrics~1').parent,'work/widgets/analytics~1');
  assert.ok(store.db.prepare('SELECT 1 FROM wiki_membership WHERE article=? AND claim=?').get('work/widgets/analytics~1',wear));
  k.apply(k.curatorBatch('work/firmware'),{replies:[],creates:[],renames:[],moves:[],merges:[{from:'work/firmware/reset-metrics~1',into:'work/widgets/analytics~1',reason:'Same subject.'}],claimMoves:[],threads:[],notes:''});
  assert.equal(k.resolve('work/firmware/reset-metrics~1'),'work/widgets/analytics~1');assert.match(k.read('work/widgets/analytics~1').markdown,/out-of-case hours/);
});
