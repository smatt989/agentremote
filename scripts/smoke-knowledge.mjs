// Isolated, synthetic evidence only; runs the provider-backed editorial pipeline.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../desktop/src/store.mjs';
import { synthesizeKnowledge } from '../desktop/src/memory-worker.mjs';
const provider=process.argv[2]||'claude';
const directory=mkdtempSync(join(tmpdir(),'agentremote-wiki-smoke-'));const store=new Store(directory);
try {
 store.save({id:'fixture',provider,status:'idle'});
 const texts=['At Example Co, revenue is measured per billing account, not per person.','orders.account_id joins accounts.id. Multiple people may share one billing account.','Revenue excludes refunded orders. The amount column is in cents, not dollars.'];
 for(const [i,text] of texts.entries())store.message('fixture',{id:'u'+i,role:'user',kind:'text',text});
 store.memory.apply(store.memory.batch('fixture'),{facts:texts.map((text,i)=>({topic:'work/example/revenue',text,quote:text,sourceMessage:'u'+i,kind:'fact'}))});
 for(let i=0;i<12;i++){
  const batch=store.knowledge.next();if(!batch)break;
  const result=await synthesizeKnowledge({...batch,provider});assert.equal(store.knowledge.apply(batch,result),true);
 }
 const pages=store.knowledge.descriptors().map(p=>store.knowledge.read(p.id));assert.ok(pages.every(p=>p.synthesized));
 const text=pages.map(p=>p.markdown).join('\n');assert.match(text,/cents/i);assert.match(text,/refund/i);assert.match(text,/account_id/);
 console.log('PASS '+provider+' evidence-backed wiki synthesis, column semantics and bounded page retrieval.');
}finally{store.close();rmSync(directory,{recursive:true,force:true});}
