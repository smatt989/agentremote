import {mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {Store} from '../desktop/src/store.mjs';
const base=mkdtempSync(join(tmpdir(),'wiki-hotload-'));const src=join(base,'src'),state=join(base,'state');cpSync('desktop/src',src,{recursive:true});
writeFileSync(join(src,'knowledge.mjs'),`export class Knowledge {constructor(store){this.store=store;this.db=store.db;this.directory=store.directory+'/knowledge';}search(){return [{id:'legacy'}];}read(){return {id:'legacy',markdown:'old'};}refresh(){}}`);
writeFileSync(join(src,'memory-worker.mjs'),`export class MemoryWorker {async learnPage(){return false;}}`);
writeFileSync(join(src,'server.mjs'),`import http from 'node:http';import {Store} from './store.mjs';import {MemoryWorker} from './memory-worker.mjs';
const store=new Store(${JSON.stringify(state)});new MemoryWorker();
const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer fixture'){res.writeHead(401);res.end('{}');return;}const u=new URL(req.url,'http://localhost');try{const result=u.pathname==='/knowledge'?{results:store.knowledge.search('')}:{page:store.knowledge.read(u.searchParams.get('id'),{offset:u.searchParams.get('offset')})};res.end(JSON.stringify(result));}catch(e){res.writeHead(e.status||500);res.end('{}');}});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));`);
const child=spawn(process.execPath,[join(src,'server.mjs')],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);
try{
 const line=await new Promise((r,j)=>{child.stdout.once('data',d=>r(String(d)));child.once('error',j);});const {port}=JSON.parse(line);const url='http://127.0.0.1:'+port;const headers={Authorization:'Bearer fixture'};
 assert.equal((await(await fetch(url+'/knowledge',{headers})).json()).results[0].id,'legacy');
 const store=new Store(state);store.save({id:'s',provider:'claude',status:'idle'});const text='Revenue excludes refunds.';store.message('s',{id:'m',role:'user',kind:'text',text});store.memory.apply(store.memory.batch('s'),{facts:[{topic:'work/example/revenue',text,quote:text,sourceMessage:'m',kind:'fact'}]});store.close();
 for(const file of ['knowledge.mjs','memory-worker.mjs'])cpSync(join('desktop/src',file),join(src,file));
 const result=execFileSync(process.execPath,['scripts/hotload-wiki.mjs',String(child.pid),src],{encoding:'utf8',timeout:30000});assert.match(result,/inspector closed/);
 assert.equal((await fetch(url+'/knowledge')).status,401);
 const page=await(await fetch(url+'/knowledge/page?id=work/example/revenue~2',{headers})).json();assert.equal(page.page.id,'work/example/revenue~1');
 assert.equal((await fetch(url+'/knowledge/page?id=work/example/revenue~1&revision=999',{headers})).status,409);
 console.log('Live wiki reload preserves authentication, resolves old IDs, checks revisions, and closes the inspector.');
}finally{child.kill('SIGTERM');await once(child,'exit');rmSync(base,{recursive:true,force:true});}
