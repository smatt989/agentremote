import {fixtureDirectory} from './fixture-directory.mjs';
// Opt-in live check. Creates a separate Codex session and sends one small model request.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../desktop/src/store.mjs';
import { Providers } from '../desktop/src/providers.mjs';
const dir=fixtureDirectory('agentremote-smoke-');
const store=new Store(dir);const providers=new Providers(store);
let session;
try {
  const provider=process.argv[2] || 'codex';
  session=await providers.create({provider,cwd:dir,title:'Agent Remote integration check'});
  if(provider==='codex') {
    const inventory=await (await providers.codex()).call('mcpServerStatus/list',{threadId:session.providerId});
    console.log(JSON.stringify({macToolsLoaded:inventory.data?.some(s=>s.name==='agent_remote_mac')}));
  }
  await providers.send(session.id,{text:'Reply with exactly AGENT_REMOTE_OK. Do not use tools or modify files.',requestId:randomUUID()});
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline && store.session(session.id).status==='running') await setTimeout(500);
  const messages=store.messages(session.id);
  const passed=messages.some(m=>m.role==='assistant' && m.text.includes('AGENT_REMOTE_OK'));
  console.log(JSON.stringify({passed,status:store.session(session.id).status,receivedItems:messages.length,errors:messages.filter(m=>m.kind==='error').map(m=>m.text)}));
  if(!passed) process.exitCode=1;
} finally {
  if(session) try { await providers.stop(session.id,true); } catch(error) {console.log(`Cleanup: ${error.message}`);}
  providers.close();store.close();rmSync(dir,{recursive:true,force:true});
}
