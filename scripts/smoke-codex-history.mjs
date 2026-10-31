import {fixtureDirectory} from './fixture-directory.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../desktop/src/store.mjs';
import {Providers} from '../desktop/src/providers.mjs';
const dir=fixtureDirectory('agentremote-history-'),store=new Store(join(dir,'state')),providers=new Providers(store);let session;
try{
 session=await providers.create({provider:'codex',cwd:dir,title:'Disposable history regression'});
 assert.deepEqual(await providers.history(session.id),[]);
 await providers.send(session.id,{text:'Reply only HISTORY_OK. Do not use tools.',requestId:'history-fixture'});
 const deadline=Date.now()+120000;
 while(['running','submitting'].includes(store.session(session.id).status)){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,200));}
 assert.ok(store.messages(session.id).some(m=>m.role==='assistant'&&m.text.includes('HISTORY_OK')));
 // Simulate opening persisted native history with a fresh local message cache.
 const fresh=new Store(join(dir,'fresh'));const reader=new Providers(fresh);fresh.save(store.session(session.id));reader.codex=()=>providers.codex();
 try{const messages=await reader.history(session.id);assert.deepEqual(messages.filter(m=>m.role==='user').map(m=>m.text),['Reply only HISTORY_OK. Do not use tools.']);assert.ok(messages.some(m=>m.role==='assistant'&&m.text.includes('HISTORY_OK')));await reader.history(session.id);assert.equal(fresh.messages(session.id).length,messages.length);}finally{reader.close();fresh.close();}
 console.log('Real Codex: empty session, live reply and history recovery with no injected context or duplicates passed.');
}finally{if(session)await providers.remove(session.id);providers.close();store.close();rmSync(dir,{recursive:true,force:true});}
