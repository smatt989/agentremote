import {mkdirSync,copyFileSync,mkdtempSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname);
mkdirSync(join(root,'build'),{recursive:true});
const directory=mkdtempSync(join(root,'build','relay-deploy-'));
const files=['package.json','package-lock.json','shared/secure-channel.mjs','relay/src/server.mjs'];
for(const file of files){const destination=join(directory,file);mkdirSync(resolve(destination,'..'),{recursive:true});copyFileSync(join(root,file),destination);chmodSync(destination,0o644);}
copyFileSync(join(root,'relay/Dockerfile'),join(directory,'Dockerfile'));
copyFileSync(join(root,'relay/railway.json'),join(directory,'railway.json'));
// The container runs as a non-root user: a source file copied with mode 0600 crashes the relay at start (Oct 15 2026).
for(const file of ['Dockerfile','railway.json'])chmodSync(join(directory,file),0o644);
console.log(`Prepared relay-only deployment directory:\n${directory}\nIncluded: public relay code, encryption primitives, dependency lockfile, Dockerfile, and Railway configuration.`);
