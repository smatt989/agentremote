import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryWorker } from '../src/memory-worker.mjs';

function fixture(t) { const dir=mkdtempSync(join(tmpdir(),'agentremote-knowledge-'));const store=new Store(dir);store.save({id:'s',provider:'claude',status:'idle',updatedAt:1});for(const scope of ['work/example','work/another','references'])store.db.prepare('INSERT INTO settings VALUES(?,?)').run('wiki-organized:'+scope,'1');t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store; }
function add(store,id,text,topic='work/example/revenue') {store.message('s',{id,role:'user',kind:'text',text});store.memory.apply(store.memory.batch('s'),{facts:[{topic,text,quote:text,sourceMessage:id,kind:'fact'}]});}
function articleBatch(store,id) {store.knowledge.refresh();const row=id?store.db.prepare('SELECT * FROM wiki_articles WHERE id=?').get(id):store.db.prepare("SELECT * FROM wiki_articles WHERE id IN (SELECT article FROM wiki_membership) ORDER BY id LIMIT 1").get();return store.knowledge.articleBatch(row);}
const synth=batch=>batch.type==='plan'?({subjects:[],assignments:batch.claims.map(c=>({claim:c.id,articles:c.articles})),merges:[],corrections:[]}):({title:'Revenue semantics',summary:'How account-level revenue is defined.',sections:batch.sources.map(f=>({text:f.text,evidence:[f.id]})),links:batch.related.map(p=>p.id)});

test('pages combine sessions, link related concepts, survive restart, and have bounded retrieval',t=>{
 const store=fixture(t);add(store,'m1','Revenue is measured at the billing account grain.');add(store,'m2','orders.account_id joins accounts.id.','work/example/orders');
 store.save({id:'s2',provider:'codex',status:'idle'});store.message('s2',{id:'m3',role:'user',kind:'text',text:'Revenue excludes refunds.'});store.memory.apply(store.memory.batch('s2'),{facts:[{topic:'work/example/revenue',text:'Revenue excludes refunds.',quote:'Revenue excludes refunds.',sourceMessage:'m3',kind:'fact'}]});
 const pages=store.knowledge.search('revenue');assert.ok(pages.length);assert.ok(JSON.stringify(pages).length<=3200);
 const page=store.knowledge.read('work/example/revenue~1');assert.match(page.markdown,/billing account/);assert.match(page.markdown,/excludes refunds/);assert.match(page.markdown,/work\/example\/orders~1/);
 const batch=articleBatch(store);assert.equal(store.knowledge.apply(batch,synth(batch)),true);assert.equal(store.knowledge.read(batch.id).synthesized,true);
 const second=new Store(store.directory);try{assert.equal(second.knowledge.read(batch.id).synthesized,true);}finally{second.close();}
 assert.ok(readdirSync(store.knowledge.directory).some(p=>p.endsWith('.md')));assert.match(readFileSync(join(store.knowledge.directory,'index.md'),'utf8'),/Revenue/);
 assert.equal(store.knowledge.read('../../etc/passwd'),null);
});

test('large topics stay one article without dropping evidence, and page reads paginate',t=>{
 const store=fixture(t);for(let i=0;i<27;i++)add(store,'m'+i,'Column '+i+' has a specific business meaning. '+('Detailed explanation. '.repeat(30)));
 const pages=store.knowledge.search('',{topic:'work/example/revenue'});assert.equal(pages.length,1);
 let text='';let offset=0;do{const page=store.knowledge.read(pages[0].id,{offset,budget:700});assert.ok(page.markdown.length<=700);text+=page.markdown;offset=page.nextOffset;}while(offset!==null);
 assert.match(text,/Column 0/);assert.match(text,/Column 26/);
 assert.notEqual(store.knowledge.search('',{limit:1,offset:1})[0].id,store.knowledge.search('',{limit:1})[0].id);
});

test('forget removes sibling facts, invalidates prose, and rejects a late synthesis',t=>{
 const store=fixture(t);add(store,'m1','Revenue excludes refunds.');const batch=articleBatch(store);store.knowledge.apply(batch,synth(batch));
 const fact=store.memory.list()[0];store.memory.apply({session:'s',seq:0,messages:[{id:'m1',role:'user',text:'Revenue excludes refunds.'}]},{facts:[{topic:'work/example/revenue',text:'Refunds are excluded.',quote:'Revenue excludes refunds.',sourceMessage:'m1',kind:'fact'}]});
 store.memory.forget(fact.id);assert.equal(store.memory.list().length,0);assert.deepEqual(store.knowledge.search('revenue'),[]);assert.equal(store.knowledge.apply(batch,synth(batch)),false);
 assert.equal(readdirSync(store.knowledge.directory,{recursive:true}).filter(p=>p.endsWith('.md')&&p!=='index.md').length,0);
});

test('deletion and expiry remove both generated prose and exported evidence',t=>{
 const store=fixture(t);add(store,'m1','Revenue excludes refunds.');const batch=articleBatch(store);store.knowledge.apply(batch,synth(batch));
 const f=store.memory.list()[0];f.expiresAt=1;store.db.prepare('UPDATE memory_facts SET data=? WHERE id=?').run(JSON.stringify(f),f.id);
 assert.equal(store.knowledge.read(batch.id),null);assert.doesNotMatch(readFileSync(join(store.knowledge.directory,'index.md'),'utf8'),/refunds/);
 add(store,'m2','Account grain is one billing account.');const pending=articleBatch(store);store.deleteSession('s');assert.equal(store.knowledge.apply(pending,synth(pending)),false);assert.deepEqual(store.knowledge.search('account'),[]);
});

test('updates retain corrections and reject invented references while allowing editorial omission',t=>{
 const store=fixture(t);add(store,'m1','Active accounts means activity in 28 days.');const old=articleBatch(store);
 add(store,'m2','Correction: active accounts now means 30 days instead of 28 days.');assert.equal(store.knowledge.apply(old,synth(old)),false);
 const batch=articleBatch(store);assert.throws(()=>store.knowledge.apply(batch,{...synth(batch),sections:[{text:'Invented.',evidence:['missing']}]}),/evidence/);
 assert.equal(store.knowledge.apply(batch,{...synth(batch),sections:[synth(batch).sections[0]]}),true);
 assert.throws(()=>store.knowledge.apply(batch,{...synth(batch),links:['other/company~1']}),/links/);
 assert.ok(store.knowledge.evidenceFor(batch.id).some(f=>f.text.includes('Correction')));
});

test('worker alternates bounded calls and retries synthesis without losing source notes',async t=>{
 const store=fixture(t);let extracts=0,syntheses=0;store.message('s',{id:'m1',role:'user',kind:'text',text:'Revenue excludes refunds.'});
 const worker=new MemoryWorker(store.memory,{extract:async()=>{extracts++;return {facts:[{topic:'work/example/revenue',text:'Revenue excludes refunds.',quote:'Revenue excludes refunds.',sourceMessage:'m1',kind:'fact'}]};},synthesize:async batch=>{syntheses++;if(syntheses===1)throw new Error('offline');return synth(batch);}});t.after(()=>worker.close());
 await worker.tick(Date.now()+200000);assert.equal(extracts,1);assert.equal(syntheses,0);
 await worker.tick(Date.now()+230000);assert.equal(syntheses,1);assert.match(store.knowledge.read('work/example/revenue~1').markdown,/refunds/);
 await worker.tick(Date.now()+240000);assert.equal(syntheses,2);
 await worker.tick(Date.now()+1200000);assert.equal(syntheses,3);
});


test('MCP exposes bounded discovery and page reading without loading unrelated projects',async t=>{
 const store=fixture(t);add(store,'m1','Revenue excludes refunds.');add(store,'m2','Another company has a different revenue rule.','work/another/revenue');
 const child=spawn(process.execPath,['desktop/src/mac-tools.mjs'],{env:{...process.env,AGENT_REMOTE_STATE:store.directory,AGENT_REMOTE_SESSION:'s'},stdio:['pipe','pipe','pipe']});
 let output='';let errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(errors)));});
 child.stdin.end([{id:1,method:'tools/list'},{id:2,method:'tools/call',params:{name:'knowledge_search',arguments:{query:'refunds',topic:'work/example'}}},{id:3,method:'tools/call',params:{name:'knowledge_read',arguments:{id:'work/example/revenue~1'}}}].map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n');
 await done;const replies=new Map(output.trim().split('\n').map(line=>JSON.parse(line)).map(r=>[r.id,r.result]));
 assert.ok(replies.get(1).tools.some(t=>t.name==='knowledge_read'));
 assert.equal(JSON.parse(replies.get(2).content[0].text)[0].id,'work/example/revenue~1');
 const page=JSON.parse(replies.get(3).content[0].text);assert.match(page.markdown,/refunds/);assert.doesNotMatch(page.markdown,/Another company/);assert.ok(page.related.every(p=>!p.id.startsWith('work/another')));
});

test('explicit saves retain complete provisional references, are idempotent, and undo preserves automatic facts',t=>{
 const store=fixture(t);const text='dbt account grain and joins. '.repeat(180)+'FINAL DEFINITION';
 store.message('s',{id:'reply',role:'assistant',kind:'text',text,createdAt:1});
 const batch=store.memory.batch('s');store.memory.apply(batch,{facts:[{topic:'work/example/dbt',text:'dbt account grain and joins.',quote:'dbt account grain and joins.',sourceMessage:'reply',kind:'fact'}]});
 store.memory.setImportant('s','reply',true);store.memory.setImportant('s','reply',true);
 const saved=store.db.prepare("SELECT data FROM memory_facts WHERE json_extract(data,'$.important')=1 ORDER BY rowid").all().map(r=>JSON.parse(r.data));
 assert.equal(saved.map(f=>f.text).join(''),text);assert.ok(saved.every(f=>f.expiresAt===null&&f.trust.includes('assistant reported')));
 assert.ok(store.memory.search('FINAL DEFINITION').some(f=>f.important));
 const reopened=new Store(store.directory);assert.equal(reopened.memory.important('s','reply'),true);reopened.close();
 assert.match(store.knowledge.read('work/example/dbt~1').markdown,/FINAL DEFINITION/);
 store.memory.setImportant('s','reply',false);assert.equal(store.memory.important('s','reply'),false);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_facts').get().n,1);
 assert.throws(()=>store.memory.setImportant('s','missing',true),/not found/);
 store.message('s',{id:'partial',role:'assistant',kind:'text',text:'streaming',partial:true});assert.throws(()=>store.memory.setImportant('s','partial',true),/completed/);
 store.memory.setImportant('s','reply',true);store.memory.forget(saved[0].id);assert.equal(store.memory.important('s','reply'),false);
});

test('lasting assistant knowledge persists and legacy expiry migration restores wiki evidence without forgotten sources',t=>{
 const store=fixture(t);
 for(const [id,kind,text] of [['fact','fact','dbt customers has one row per account.'],['decision','decision','Use account_id for the join.'],['progress','progress','The dbt analysis is running.'],['forgotten','fact','Obsolete dbt definition.']]) {
  store.message('s',{id,role:'assistant',kind:'text',text});
  store.memory.apply(store.memory.batch('s'),{facts:[{topic:'work/example/dbt',text,quote:text,sourceMessage:id,kind}]});
 }
 let records=store.db.prepare('SELECT data FROM memory_facts').all().map(r=>JSON.parse(r.data));
 assert.ok(records.filter(f=>f.kind!=='progress').every(f=>f.expiresAt===null&&f.trust.includes('verify')));
 assert.ok(records.find(f=>f.kind==='progress').expiresAt>Date.now());
 store.memory.forget(records.find(f=>f.sourceMessage==='forgotten').id);
 store.db.exec("UPDATE memory_facts SET data=json_set(data,'$.expiresAt',1); DELETE FROM settings WHERE key='durableKnowledgeV1'");
 assert.equal(store.knowledge.read('work/example/dbt~1'),null);
 const reopened=new Store(store.directory);
 try {
  const page=reopened.knowledge.read('work/example/dbt~1');assert.match(page.markdown,/one row per account/);assert.match(page.markdown,/Use account_id/);assert.doesNotMatch(page.markdown,/analysis is running|Obsolete/);
  assert.ok(reopened.memory.search('customers').some(f=>f.expiresAt===null));
  reopened.memory.migrateRetention();assert.match(reopened.knowledge.read('work/example/dbt~1').markdown,/one row per account/);
 }finally{reopened.close();}
});

test('editorial planning merges topics, creates overview/procedure, redirects every old batch ID and preserves provenance',t=>{
 const store=fixture(t);
 add(store,'a','Use the Hex workspace connection for Example analytics.','work/example/hex');
 add(store,'b','The Hex instance requires an authenticated CLI session.','work/example/hex-access');
 let batch=store.knowledge.next();assert.equal(batch.type,'plan');
 const target='work/example/hex~1';const overview='work/example~1';
 const result={subjects:[{id:overview,title:'Example',summary:'Example analytics and tools.',kind:'overview',parent:null,aliases:[]},{id:target,title:'Connecting to Example’s Hex instance',summary:'Connection prerequisites and procedure.',kind:'procedure',parent:overview,aliases:['Hex access']}],assignments:batch.claims.map(c=>({claim:c.id,articles:[target]})),merges:[{from:'work/example/hex-access~1',into:target}],corrections:[]};
 assert.equal(store.knowledge.apply(batch,result),true);
 assert.equal(store.knowledge.read('work/example/hex-access~3').id,target);
 assert.equal(store.knowledge.search('Hex access')[0].id,target);
 assert.equal(store.knowledge.evidenceFor(target).length,2);
 assert.equal(store.knowledge.read(target).breadcrumbs[0].id,overview);
 assert.ok(store.knowledge.read(overview).children.some(c=>c.id===target));
 const writing=articleBatch(store,target);const response=synth(writing);response.sections=[{heading:'Connection',text:'See [[work/example~1|Example]] for context.',evidence:writing.sources.map(f=>f.id)}];response.links=[overview];
 assert.equal(store.knowledge.apply(writing,response),true);
 const page=store.knowledge.read(target);assert.match(page.markdown,/agentremote-wiki:\/\/article\?id=work%2Fexample~1/);
 assert.ok(store.knowledge.read(overview).backlinks.some(c=>c.id===target));
 assert.equal(store.db.prepare('SELECT count(*) n FROM wiki_revisions WHERE article=?').get(target).n,1);
 add(store,'c','The Hex connection supports saved notebooks.','work/example/hex-access');
 assert.equal(store.knowledge.read(target).synthesized,true);assert.equal(store.knowledge.read(target).pending,true);
 assert.equal(store.knowledge.evidenceFor(target).length,3);
});

test('duplicate observations share claims but preserve independent sources and forget invalidates dependent prose',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');
 store.save({id:'other',provider:'claude',status:'idle'});store.message('other',{id:'b',role:'assistant',kind:'text',text:'Revenue excludes refunds.'});store.memory.apply(store.memory.batch('other'),{facts:[{topic:'work/example/revenue',text:'Revenue excludes refunds.',quote:'Revenue excludes refunds.',sourceMessage:'b',kind:'fact'}]});
 assert.equal(store.db.prepare('SELECT count(*) n FROM wiki_claims').get().n,1);
 const batch=articleBatch(store);store.knowledge.apply(batch,synth(batch));
 assert.equal(store.knowledge.evidenceFor(batch.id).length,2);
 store.memory.forget(batch.sources[0].id);
 assert.equal(store.knowledge.read(batch.id).synthesized,false);
 assert.equal(store.db.prepare('SELECT count(*) n FROM wiki_revisions').get().n,0);
 assert.equal(store.knowledge.evidenceFor(batch.id).length,1);
});

test('invalid editorial plans roll back, stale plans cannot publish, and corrections cannot cross organizations',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');const batch=store.knowledge.next();
 assert.throws(()=>store.knowledge.apply(batch,{...synth(batch),assignments:[]}),/omitted/);
 assert.throws(()=>store.knowledge.apply(batch,{...synth(batch),subjects:[{id:'work/example~1',title:'Example',summary:'',kind:'overview',parent:'work/example/revenue~1',aliases:[]}]}),/Cyclic/);
 assert.equal(store.knowledge.read('work/example~1').breadcrumbs.length,0);
 add(store,'b','Correction: include refunds from this month.');assert.equal(store.knowledge.apply(batch,synth(batch)),false);
 const current=store.knowledge.next();const claims=current.claims;const newer=claims.find(c=>c.text.startsWith('Correction'));const older=claims.find(c=>c.text.startsWith('Revenue'));
 store.knowledge.apply(current,{...synth(current),corrections:[{older:older.id,newer:newer.id,reason:'Explicit scoped correction.'}]});
 assert.equal(store.db.prepare('SELECT status FROM wiki_claims WHERE id=?').get(older.id).status,'superseded');
});

test('article pagination rejects a changed revision and unsafe links cannot be published',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');let batch=articleBatch(store);store.knowledge.apply(batch,synth(batch));
 const first=store.knowledge.read(batch.id,{budget:500});batch=articleBatch(store);store.knowledge.apply(batch,{...synth(batch),summary:'Updated explanation.'});
 assert.throws(()=>store.knowledge.read(batch.id,{offset:500,revision:first.revision}),/changed/);
 batch=articleBatch(store);assert.throws(()=>store.knowledge.apply(batch,{...synth(batch),sections:[{heading:'Links',text:'[[work/missing~1|Invented]]',evidence:[batch.sources[0].id]}]}),/links/);
 assert.equal(store.knowledge.renderText('[Launch](file:///private/test)'),'Launch');
});

test('new observations queue only unplanned claims and imported references can join canonical subjects',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');let plan=store.knowledge.next();store.knowledge.apply(plan,synth(plan));
 add(store,'b','Revenue uses the billing account grain.');plan=store.knowledge.next();assert.equal(plan.claims.length,1);assert.match(plan.claims[0].text,/billing account/);store.knowledge.apply(plan,synth(plan));
 add(store,'c','Example revenue is reported monthly.','references/example-revenue');plan=store.knowledge.planBatch(store.db.prepare("SELECT * FROM wiki_jobs WHERE id='references'").get());assert.equal(plan.scope,'references');
 const result={...synth(plan),assignments:plan.claims.map(c=>({claim:c.id,articles:['work/example/revenue~1']})),merges:[{from:'references/example-revenue~1',into:'work/example/revenue~1'}]};
 store.knowledge.apply(plan,result);assert.equal(store.knowledge.read('references/example-revenue~1').id,'work/example/revenue~1');assert.equal(store.knowledge.evidenceFor('work/example/revenue~1').length,3);
});

test('source withdrawal invalidates derived overview prose as well as leaf articles',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Orders use account IDs.','work/example/orders');
 const leaf=articleBatch(store,'work/example/revenue~1');store.knowledge.apply(leaf,synth(leaf));
 const parent=articleBatch(store,'work/example~1');store.knowledge.apply(parent,{title:'Example',summary:'Revenue excludes refunds.',sections:[],links:[]});
 store.db.prepare("UPDATE wiki_subjects SET summary='Revenue excludes refunds.',aliases='[\"refunds\"]' WHERE id='work/example~1'").run();
 store.memory.forget(leaf.sources[0].id);
 assert.doesNotMatch(store.knowledge.read('work/example~1').markdown,/refunds/);
 assert.doesNotMatch(readFileSync(join(store.knowledge.directory,'index.md'),'utf8'),/refunds/);
});

test('semantic review gates publication without replacing a supported prior article',async t=>{
 const {synthesizeKnowledge}=await import('../src/memory-worker.mjs');const store=fixture(t);add(store,'a','Revenue excludes refunds.');const batch=articleBatch(store);store.knowledge.apply(batch,synth(batch));
 let calls=0;
 await assert.rejects(()=>synthesizeKnowledge(batch,{extract:async()=>++calls%2===1?synth(batch):{approved:false,issues:['Unsupported claim.']}}),/review/);
 assert.equal(calls,4);assert.equal(store.knowledge.read(batch.id).synthesized,true);
});

test('whole-subject organization must retire provisional names before claim routing',t=>{
 const store=fixture(t);add(store,'a','Use the Hex workspace connection.','work/example/hex');add(store,'b','Authenticate before connecting to Hex.','work/example/hex-access');store.db.prepare("DELETE FROM settings WHERE key='wiki-organized:work/example'").run();
 const batch=store.knowledge.next();assert.equal(batch.stage,'structure');assert.equal(batch.articles.length,3);
 assert.throws(()=>store.knowledge.apply(batch,synth(batch)),/provisional/);
 const root={id:'work/example~1',title:'Example',summary:'Example analytics.',kind:'overview',parent:null,aliases:[]};
 const target={id:'work/example/hex~1',title:'Connecting to Example’s Hex instance',summary:'Connection prerequisites.',kind:'procedure',parent:root.id,aliases:['Hex access']};
 store.knowledge.apply(batch,{subjects:[root,target],assignments:[],merges:[{from:'work/example/hex-access~1',into:target.id}],corrections:[]});
 assert.equal(store.knowledge.evidenceFor(target.id).length,2);assert.equal(store.knowledge.next().stage,'route');
});

test('legacy batch prose migrates into one readable provisional article with old IDs redirected',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');const f=store.memory.list()[0];
 store.db.exec('CREATE TABLE knowledge_pages(id TEXT,topic TEXT,data TEXT); CREATE TABLE knowledge_search(id TEXT,text TEXT)');
 store.db.prepare('INSERT INTO knowledge_pages VALUES(?,?,?)').run('work/example/revenue~2','work/example/revenue',JSON.stringify({title:'Repeated title',summary:'Revenue semantics.',sections:[{text:'Revenue excludes refunds.',evidence:[f.id]}],links:[],synthesized:true}));
 store.db.exec("DELETE FROM wiki_articles; DELETE FROM settings WHERE key='wiki-v2-migrated'");
 const reopened=new Store(store.directory);let page;try{page=reopened.knowledge.read('work/example/revenue~2');}finally{reopened.close();}
 assert.equal(page.id,'work/example/revenue~1');assert.equal(page.synthesized,true);assert.equal(page.pending,true);assert.match(page.markdown,/Revenue semantics/);assert.equal(store.db.prepare('SELECT count(*) n FROM knowledge_pages').get().n,0);
});

test('overviews cite derived child summaries and refresh after child changes without inventing independent evidence',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');const child=articleBatch(store,'work/example/revenue~1');store.knowledge.apply(child,synth(child));
 const parent=articleBatch(store,'work/example~1');const evidence=parent.sources.find(s=>s.sourceArticle===child.id);assert.ok(evidence);assert.match(evidence.trust,/Not independent/);
 store.knowledge.apply(parent,{title:'Example',summary:'A guide to revenue.',sections:[{heading:'Analytics',text:'See [[work/example/revenue~1|revenue semantics]].',evidence:[evidence.id]}],links:[child.id]});
 assert.equal(store.knowledge.read(parent.id).synthesized,true);
 const revision=store.knowledge.read(parent.id).revision;const update=articleBatch(store,child.id);store.knowledge.apply(update,{...synth(update),summary:'Updated account-level revenue definitions.'});
 assert.equal(store.knowledge.read(parent.id).pending,true);assert.ok(store.knowledge.read(parent.id).revision>revision);
 assert.equal(store.db.prepare("SELECT count(*) n FROM memory_facts WHERE id LIKE 'article:%'").get().n,0);
});

test('article dependencies follow parent relationships even when stable slugs have equal depth',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Orders join accounts.','work/example/orders');
 store.db.prepare("UPDATE wiki_subjects SET parent='work/example/revenue~1' WHERE id='work/example/orders~1'").run();store.knowledge.refresh();
 const next=store.knowledge.pendingArticles();assert.equal(next[0].id,'work/example/orders~1');assert.ok(!next.some(p=>p.id==='work/example/revenue~1'));
});

test('forgetting a source preserves unrelated published articles and their revision history',t=>{
 const store=fixture(t);add(store,'a','Revenue excludes refunds.');add(store,'b','Another business measures revenue monthly.','work/another/revenue');
 const first=articleBatch(store,'work/example/revenue~1');store.knowledge.apply(first,synth(first));const other=articleBatch(store,'work/another/revenue~1');store.knowledge.apply(other,synth(other));const before=store.knowledge.read(other.id);
 store.memory.forget(first.sources[0].id);
 const after=store.knowledge.read(other.id);assert.equal(after.synthesized,true);assert.equal(after.revision,before.revision);assert.equal(store.db.prepare('SELECT count(*) n FROM wiki_revisions WHERE article=?').get(other.id).n,1);
});

test('semantic scope rejection requeues supporting claims with bounded editorial feedback',t=>{
 const store=fixture(t);add(store,'m1','Revenue excludes refunds.');
 const plan=store.knowledge.next();assert.equal(plan.type,'plan');assert.equal(store.knowledge.apply(plan,synth(plan)),true);
 const batch=articleBatch(store);const diagnostic={review:{issues:['This evidence belongs in the revenue definition article.']}};
 assert.equal(store.knowledge.reviewFailed(batch,diagnostic),true);
 const retry=store.knowledge.next();assert.equal(retry.type,'plan');assert.equal(retry.claims.length,1);assert.equal(retry.feedback.article,batch.id);assert.match(retry.feedback.issues[0],/revenue/);
 assert.equal(store.knowledge.reviewFailed(batch,diagnostic),true);assert.equal(store.knowledge.reviewFailed(batch,diagnostic),false);
 assert.equal(store.knowledge.evidenceFor(batch.id).length,1);
});

test('the index lists every article in one call and reads reuse the projection until evidence changes',async t=>{
 const store=fixture(t);add(store,'m1','Revenue is measured at the billing account grain.');add(store,'m2','orders.account_id joins accounts.id.','work/example/orders');
 const index=store.knowledge.index();
 assert.deepEqual(index.map(p=>p.id).sort(),['work/example/orders~1','work/example/revenue~1','work/example~1']);
 assert.equal(index[0].id,'work/example~1');
 assert.ok(index.every(p=>typeof p.title==='string'&&typeof p.topic==='string'&&'parent' in p&&typeof p.pending==='boolean'&&p.summary.length<=200&&!('markdown' in p)));
 let rebuilds=0;const rebuild=store.knowledge.rebuild.bind(store.knowledge);store.knowledge.rebuild=()=>{rebuilds++;return rebuild();};
 store.knowledge.index();store.knowledge.search('revenue');store.knowledge.read('work/example/revenue~1');store.knowledge.index();
 assert.equal(rebuilds,0);
 // Evidence edits outside the memory API are still noticed on the next read, exactly once.
 store.db.prepare("UPDATE memory_facts SET data=json_set(data,'$.text','Revenue is measured per billing account.','$.quote','Revenue is measured per billing account.') WHERE json_extract(data,'$.sourceMessage')='m1'").run();
 assert.match(store.knowledge.read('work/example/revenue~1').markdown,/per billing account/);assert.equal(rebuilds,1);
 store.knowledge.read('work/example/revenue~1');store.knowledge.index();assert.equal(rebuilds,1);
 // A retained fact that expires disappears without any write.
 store.db.prepare("UPDATE memory_facts SET data=json_set(data,'$.expiresAt',?) WHERE json_extract(data,'$.sourceMessage')='m2'").run(Date.now()+80);
 assert.ok(store.knowledge.index().some(p=>p.id==='work/example/orders~1'));assert.equal(rebuilds,2);
 await new Promise(r=>setTimeout(r,120));
 assert.equal(store.knowledge.index().some(p=>p.id==='work/example/orders~1'),false);assert.equal(rebuilds,3);
 // Changes committed by another connection are noticed too.
 const other=new Store(store.directory);
 try{other.message('s',{id:'m3',role:'user',kind:'text',text:'Refunds are excluded from revenue.'});other.memory.apply(other.memory.batch('s'),{facts:[{topic:'work/example/revenue',text:'Refunds are excluded from revenue.',quote:'Refunds are excluded from revenue.',sourceMessage:'m3',kind:'fact'}]});}
 finally{other.close();}
 // The other connection already rebuilt the projection at this version, so this one reuses it rather than rebuilding.
 assert.match(store.knowledge.read('work/example/revenue~1').markdown,/Refunds are excluded/);assert.equal(rebuilds,3);
 assert.equal(store.knowledge.read('work/example/revenue~1',{budget:60000}).nextOffset,null);
});
