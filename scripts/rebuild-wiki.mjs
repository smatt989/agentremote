// Run the app's editorial pipeline on an isolated state copy for review.
// Arguments: state directory, maximum jobs, concurrency (1–3), preferred scope prefixes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../desktop/src/store.mjs';
import { synthesizeKnowledge } from '../desktop/src/memory-worker.mjs';
const directory=process.argv[2];if(!directory)throw Error('Usage: node scripts/rebuild-wiki.mjs STATE_DIRECTORY [MAX_JOBS] [CONCURRENCY] [SCOPES]');
const store=new Store(directory);const max=Number(process.argv[3]||250);const concurrency=Math.max(1,Math.min(3,Number(process.argv[4])||1));const preferred=(process.argv[5]||'').split(',').filter(Boolean);const failed=new Set(),active=new Set();const controller=new AbortController();let count=0;
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
function choose(){
 store.db.prepare("INSERT INTO settings VALUES('wiki-bulk-until',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()+20*60_000));
 store.knowledge.refresh();
 for(const scope of preferred){
  const job=store.db.prepare('SELECT * FROM wiki_jobs WHERE id=? AND (completed IS NULL OR completed!=signature)').get(scope);
  if(job&&!active.has('plan:'+scope)&&!failed.has('plan:'+scope))return store.knowledge.planBatch(job);
  if(job)continue;
  const article=store.knowledge.pendingArticles(new Set([...active,...failed])).find(a=>a.id.startsWith(scope+'/')||a.id===scope+'~1');
  if(article)return store.knowledge.articleBatch(article);
 }
 return store.knowledge.next(new Set([...failed,...active]));
}
async function loop(){
 while(count<max&&!controller.signal.aborted){
  const batch=choose();if(!batch)break;count++;active.add(batch.id);const start=Date.now();let result;
  try {
   result=await synthesizeKnowledge({...batch,provider:'claude'},{signal:controller.signal});
   if(controller.signal.aborted)break;
   writeFileSync(join(directory,'last-editorial-success-'+batch.id.replaceAll('/','-')+'.json'),JSON.stringify({batch,result}),{mode:0o600});
   const applied=store.knowledge.apply(batch,result);
   if(applied&&batch.type==='plan')for(const id of failed)if(id.startsWith(batch.scope+'/')||id===batch.scope+'~1')failed.delete(id);
   const summary=batch.type==='steward'?{mode:batch.mode,decision:result.decision,summaryChange:result.summaryChange,reason:String(result.reason||'').slice(0,240),removals:result.removals?.length,handoffs:result.handoffs?.length,verify:result.verify?.length,threads:result.threads?.length,replies:result.replies?.length}:batch.type==='curate'?{merges:result.merges.length,moves:result.moves.length,renames:result.renames.length,creates:result.creates.length,claimMoves:result.claimMoves.length,replies:result.replies.length,threads:result.threads.length}:batch.type==='verify'?{outcome:result.outcome,path:result.path}:batch.type==='librarian'?{threads:result.threads.length}:{};
   console.log(JSON.stringify({job:batch.id,type:batch.type,applied,seconds:Math.round((Date.now()-start)/1000),...summary}));
  }catch(e){store.knowledge.reviewFailed(batch,e.diagnostic);if(e.diagnostic)writeFileSync(join(directory,'review-rejected-'+batch.id.replaceAll('/','-')+'.json'),JSON.stringify(e.diagnostic),{mode:0o600});if(result)writeFileSync(join(directory,'editorial-rejected-'+batch.id.replaceAll('/','-')+'.json'),JSON.stringify({batch,result}),{mode:0o600});console.log(JSON.stringify({job:batch.id,type:batch.type,error:e.message.slice(0,300)}));failed.add(batch.id);}
  finally{active.delete(batch.id);}
 }
}
try {await Promise.all(Array.from({length:concurrency},()=>loop()));console.log(JSON.stringify({articles:store.knowledge.descriptors().length,pending:store.db.prepare('SELECT count(*) n FROM wiki_articles WHERE pending=1').get().n,failed:failed.size}));}
finally {store.db.prepare("DELETE FROM settings WHERE key='wiki-bulk-until'").run();store.close();}
