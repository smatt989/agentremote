import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Store} from '../src/store.mjs';
test('completed text controls ordering; polling, replay, tools and partial output do not',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-order-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.save({id:'a',updatedAt:10});store.save({id:'b',updatedAt:20});
 const order=()=>store.sessions().sort((a,b)=>b.updatedAt-a.updatedAt).map(s=>s.id);
 store.message('a',{id:'a1',role:'user',kind:'text',text:'A',completedAt:100});store.message('b',{id:'b1',role:'assistant',kind:'text',text:'B',completedAt:200});
 assert.deepEqual(order(),['b','a']);store.save({...store.session('a'),updatedAt:99999});store.append('a','partial','stream');store.message('a',{id:'tool',role:'tool',kind:'command',text:'pwd'});assert.deepEqual(order(),['b','a']);
 store.message('a',{id:'a1',role:'user',kind:'text',text:'A',completedAt:100});assert.deepEqual(order(),['b','a']);
 store.message('a',{id:'partial',role:'assistant',kind:'text',text:'stream finished',completedAt:300});assert.deepEqual(order(),['a','b']);assert.equal(store.session('a').lastMessageAt,300);
});

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'ar-read-'));const store=new Store(dir);store.save({id:'s',createdAt:1,status:'idle'});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}
const view=store=>store.sessionView(store.session('s'));
test('completion replay cannot change order, timestamp, or a saved read receipt',t=>{
 const store=fixture(t);store.message('s',{id:'a',role:'assistant',kind:'text',text:'Finished',completedAt:100});
 const first=view(store);assert.equal(first.unread,true);store.markRead('s',first.latestAssistantToken);
 store.message('s',{id:'a',role:'assistant',kind:'text',text:'Finished',completedAt:99999});
 assert.equal(view(store).lastCompletedAt,100);assert.equal(view(store).unread,false);
 const reopened=new Store(store.directory);try{assert.equal(view(reopened).unread,false);}finally{reopened.close();}
});
test('new user messages sort sessions but only completed assistant responses become unread',t=>{
 const store=fixture(t);store.message('s',{id:'u',role:'user',kind:'text',text:'Question',completedAt:100});assert.equal(view(store).unread,false);
 store.append('s','a','Partial');store.message('s',{id:'tool',role:'tool',kind:'command',text:'command',completedAt:200});assert.equal(view(store).lastCompletedAt,100);assert.equal(view(store).unread,false);
 store.message('s',{id:'a',role:'assistant',kind:'text',text:'Complete',completedAt:300});assert.equal(view(store).unread,true);assert.equal(view(store).lastCompletedAt,300);
 store.markRead('s',view(store).latestAssistantToken);
 store.message('s',{id:'u2',role:'user',kind:'text',text:'Thanks',completedAt:400});assert.equal(view(store).lastCompletedAt,400);assert.equal(view(store).lastCompletedRole,'user');assert.equal(view(store).unread,false);
});
test('stale receipts and older history imports cannot hide a newer unread response',t=>{
 const store=fixture(t);store.message('s',{id:'a1',role:'assistant',kind:'text',text:'First',completedAt:100});const first=view(store);
 store.message('s',{id:'a2',role:'assistant',kind:'text',text:'Second',completedAt:200});store.markRead('s',first.latestAssistantToken);assert.equal(view(store).unread,true);
 store.markRead('s',view(store).latestAssistantToken);
 store.message('s',{id:'old',role:'assistant',kind:'text',text:'Imported old answer',completedAt:50});assert.equal(view(store).unread,false);assert.equal(view(store).lastCompletedAt,200);
 store.deleteSession('s');assert.equal(store.db.prepare('SELECT count(*) AS n FROM session_reads').get().n,0);
});
test('fetching history does not mark read; the authenticated receipt endpoint does',async t=>{
 const {createServer}=await import('../src/server.mjs');const store=fixture(t);store.message('s',{id:'a',role:'assistant',kind:'text',text:'Answer',completedAt:100});
 const providers={history:async()=>{},discover:async()=>({warnings:[]})};const {server}=createServer({store,providers});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;const headers={Authorization:'Bearer '+store.createDevice('fixture').token,'Content-Type':'application/json'};
 assert.equal((await fetch(base+'/sessions/s/read',{method:'POST',body:'{}'})).status,401);
 const detail=await(await fetch(base+'/sessions/s',{headers})).json();assert.equal(detail.session.unread,true);assert.equal(view(store).unread,true);
 const response=await fetch(base+'/sessions/s/read',{method:'POST',headers,body:JSON.stringify({token:detail.session.latestAssistantToken})});assert.equal(response.status,200);assert.equal((await response.json()).session.unread,false);
 assert.equal((await fetch(base+'/sessions/s/read',{method:'POST',headers,body:'{}'})).status,400);
});

test('late history imports page chronologically without losing tied timestamps',t=>{
 const store=fixture(t);
 for(let i=300;i>=0;i--)store.message('s',{id:`m${i}`,role:'assistant',kind:'text',text:`Message ${i}`,completedAt:100+Math.floor(i/2)});
 const newest=store.messages('s');assert.equal(newest.length,200);assert.equal(newest.at(-1).id,'m300');
 const older=store.messages('s',newest[0].seq);assert.equal(older.length,101);
 const all=[...older,...newest];assert.equal(new Set(all.map(m=>m.id)).size,301);
 for(let i=1;i<all.length;i++)assert.ok(all[i].completedAt>=all[i-1].completedAt);
 assert.deepEqual(store.messages('s',older[0].seq),[]);
 store.message('s',{id:'old',role:'assistant',kind:'text',text:'Imported',completedAt:1});
 assert.equal(store.messages('s').at(-1).id,'m300');
});
