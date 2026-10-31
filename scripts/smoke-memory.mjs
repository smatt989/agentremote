import {fixtureDirectory} from './fixture-directory.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../desktop/src/store.mjs';
import {extractMemory} from '../desktop/src/memory-worker.mjs';
const directory=fixtureDirectory('agentremote-memory-smoke-');const store=new Store(directory);
try {
  store.save({id:'fixture',provider:process.argv[2]||'claude',status:'ended'});
  store.message('fixture',{id:'u1',role:'user',kind:'text',text:'I use Hex.tech for analytics at my day job, Northstar Example. In our domain model, an account can have multiple workspaces. Join workspaces.account_id to accounts.id. Active accounts means at least one completed job in the trailing 28 days.'});
  store.message('fixture',{id:'a1',role:'assistant',kind:'text',text:'Perhaps Northstar uses Snowflake, but that is only a guess and has not been confirmed.'});
  const batch=store.memory.batch('fixture');
  const result=await extractMemory(batch,[],{provider:process.argv[2]||'claude'});if(process.env.AGENT_REMOTE_SMOKE_DEBUG)console.log(JSON.stringify(result));store.memory.apply(batch,result);
  const hits=store.memory.search('analytics Hex workspaces accounts');
  assert.ok(hits.some(h=>h.kind==='fact'&&/hex/i.test(h.text)),'must learn Hex from user evidence');
  assert.ok(!hits.some(h=>h.kind==='fact'&&/snowflake/i.test(h.text)),'must not learn assistant speculation');
  assert.ok(hits.some(h=>h.kind==='fact'&&/account/i.test(h.text)),'must learn domain context');
  store.message('fixture',{id:'u2',role:'user',kind:'text',text:'Actually, make that 30 days.'});
  const correction=store.memory.batch('fixture');const corrected=await extractMemory(correction,store.memory.topics(),{provider:process.argv[2]||'claude'});store.memory.apply(correction,corrected);
  assert.ok(store.memory.list().some(f=>f.sourceMessage==='u2'&&/30/.test(f.text)&&/account/i.test(f.text)),'short correction must retain domain context');
  console.log('PASS real '+(process.argv[2]||'claude')+' extraction, local persistence, domain retrieval and speculation exclusion and contextual correction. Initial facts: '+result.facts.length);
} finally {store.close();rmSync(directory,{recursive:true,force:true});}
