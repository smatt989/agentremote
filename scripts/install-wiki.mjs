// Import only a reviewed wiki projection. Conversations, pairings, and provider state stay live.
// Make a consistent private state.sqlite backup before running this maintenance command.
import { Store } from '../desktop/src/store.mjs';
import { resolve } from 'node:path';
const [live,candidate]=process.argv.slice(2);if(!live||!candidate||resolve(live)===resolve(candidate))throw Error('Usage: node scripts/install-wiki.mjs LIVE_STATE REVIEWED_STATE');
const store=new Store(live);
try {
 store.db.prepare('ATTACH DATABASE ? AS reviewed').run(resolve(candidate,'state.sqlite'));
 const tables=['wiki_subjects','wiki_claims','wiki_evidence','wiki_membership','wiki_articles','wiki_revisions','wiki_jobs','wiki_planned'];
 for(const table of tables)if(!store.db.prepare("SELECT 1 FROM reviewed.sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Incomplete reviewed wiki.');
 store.knowledge.transaction(()=>{
  for(const table of tables){store.db.exec('DELETE FROM '+table);store.db.exec('INSERT INTO '+table+' SELECT * FROM reviewed.'+table);}
  store.db.exec("DELETE FROM settings WHERE key LIKE 'wiki-%'; INSERT INTO settings SELECT * FROM reviewed.settings WHERE key LIKE 'wiki-%' AND key NOT IN ('wiki-v2-migrated','wiki-bulk-until');");
  // Reconcile all copied evidence against current source retention and new observations.
  store.knowledge.rebuild();store.knowledge.reindex();store.knowledge.exportAll();
 });
 store.db.exec('DETACH DATABASE reviewed');
 console.log(JSON.stringify({articles:store.knowledge.descriptors().length,pending:store.db.prepare('SELECT count(*) n FROM wiki_articles WHERE pending=1').get().n}));
}finally{store.close();}
