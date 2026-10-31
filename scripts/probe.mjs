import {fixtureDirectory} from './fixture-directory.mjs';
// Read-only provider checks. Reports counts, never conversation contents or credentials.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../desktop/src/store.mjs';
import { Providers } from '../desktop/src/providers.mjs';
const dir = fixtureDirectory('agentremote-probe-');
const store = new Store(dir); const providers = new Providers(store);
try {
  const result=await providers.discover();
  const counts=result.sessions.reduce((all,session)=>{all[session.provider]=(all[session.provider]||0)+1;return all;},{});
  console.log(JSON.stringify({counts,warnings:result.warnings},null,2));
  for(const provider of ['codex','claude']) {
    const session=result.sessions.find(s=>s.provider===provider);
    if(session) console.log(JSON.stringify({provider,historyItems:(await providers.history(session.id)).length}));
  }
} finally {providers.close();store.close();rmSync(dir,{recursive:true,force:true});}
