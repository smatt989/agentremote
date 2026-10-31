import {fixtureDirectory} from './fixture-directory.mjs';
// Creates only disposable sessions; never deletes a pre-existing provider session.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../desktop/src/store.mjs';
import {Providers} from '../desktop/src/providers.mjs';
import {randomUUID} from 'node:crypto';
const provider=process.argv[2] || 'codex';
if(!['codex','claude'].includes(provider))throw new Error('Choose codex or claude.');
const directory=fixtureDirectory('agentremote-lifecycle-');
const store=new Store(join(directory,'state'));const providers=new Providers(store);
let session;
try {
  session=await providers.create({provider,cwd:directory,title:'Agent Remote disposable lifecycle test'});
  await providers.send(session.id,{text:'Reply with exactly OK. Do not run tools or change files.',requestId:randomUUID()});
  const deadline=Date.now()+120_000;
  while(['running','submitting'].includes(store.session(session.id).status)) {
    if(Date.now()>deadline)throw new Error('Provider response timed out.');
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(store.session(session.id).status==='error')throw new Error('Provider response failed.');
  await providers.stop(session.id,true);
  if(store.session(session.id).status!=='ended')throw new Error('Session did not end.');
  await providers.remove(session.id);
  if(store.session(session.id) || store.messages(session.id).length)throw new Error('Session data remains.');
  console.log(`${provider}: real reply, end, and permanent deletion passed.`);
} finally {
  // Clean up only the session this invocation created, if a prior step failed.
  if(session && store.session(session.id)) {
    try { await providers.remove(session.id); }
    catch(error){console.error(`Disposable ${provider} session cleanup failed: ${error.message}`);}
  }
  providers.close();store.close();rmSync(directory,{recursive:true,force:true});
}
