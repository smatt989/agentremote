import {fixtureDirectory} from './fixture-directory.mjs';
// Only disposable fixture state and newly-created provider sessions are used.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../desktop/src/store.mjs';
import {Providers} from '../desktop/src/providers.mjs';
import {pendingQuestions} from '../desktop/src/questions.mjs';
const provider='claude';const directory=fixtureDirectory('agentremote-context-session-');const store=new Store(join(directory,'state'));const providers=new Providers(store);let session;
async function settled() {const deadline=Date.now()+120000;while(['running','submitting'].includes(store.session(session.id).status)){if(Date.now()>deadline)throw new Error('Timed out');await new Promise(r=>setTimeout(r,200));}if(store.session(session.id).status==='error')throw new Error('Provider failed');}
try {
  store.save({id:'fixture-history',provider:'claude',status:'ended'});
  const text='For Northstar Example, I use Hex.tech for analytics. Active accounts have at least one completed job in the trailing 28 days.';
  store.message('fixture-history',{id:'fixture-message',role:'user',kind:'text',text});
  store.memory.apply(store.memory.batch('fixture-history'),{facts:[{topic:'work/northstar/analytics',kind:'fact',text,sourceMessage:'fixture-message',quote:text}]});
  session=await providers.create({provider,cwd:directory,title:'Agent Remote disposable memory/question test'});
  await providers.send(session.id,{text:'For Northstar Example, remind me which analytics tool I use and our definition of active accounts. Answer concisely using available context. Do not browse or change files.',requestId:randomUUID()});await settled();
  const answer=store.messages(session.id).filter(m=>m.role==='assistant'&&m.kind==='text').map(m=>m.text).join('\n');assert.match(answer,/Hex/i);assert.match(answer,/28/);
  await providers.send(session.id,{text:'Test the phone clarification interface: use your built-in AskUserQuestion tool (not the MCP ask_question tool) to ask which retention definition I want, with Customer retention and Revenue retention as choices. Do not pick one; wait for my answer.',requestId:randomUUID()});await settled();
  const q=pendingQuestions(store,session.id)[0];assert.ok(q,'must create actual structured question');assert.equal(q.native,true,'must use native Claude question protocol');assert.equal(q.questions[0].options.length,2);
  await providers.answer(session.id,q.id,{[q.questions[0].id]:'Revenue retention. Acknowledge this choice in one sentence; no follow-up questions.'});await settled();
  assert.equal(pendingQuestions(store,session.id).length,0);const latest=store.messages(session.id).filter(m=>m.role==='assistant'&&m.kind==='text').at(-1);assert.match(latest.text,/revenue/i);
  console.log('PASS '+provider+': new session recalls local domain facts, native Claude question, free-text answer and continuation.');
} finally {if(session&&store.session(session.id)){try{await providers.remove(session.id);}catch(e){console.error('Disposable session cleanup failed: '+e.message);}}providers.close();store.close();rmSync(directory,{recursive:true,force:true});}
