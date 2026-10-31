import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,utimesSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {createServer,artifactDirectory,conversationReply} from '../src/server.mjs';import {Providers} from '../src/providers.mjs';
import {createQuestion,cancelQuestions} from '../src/questions.mjs';import {claudeUsage,codexUsage,accountUsage} from '../src/session-controls.mjs';import {relayRoute} from '../src/relay-client.mjs';

const until=async(check,ms=3000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('timed out');await new Promise(r=>setTimeout(r,10));}};
function fixture(t,{status='running',control='managed',provider='claude',external=false,providers}={}){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ar-queue-'))),store=new Store(dir),id=provider+':q',sends=[];
 store.save({id,provider,providerId:'q',cwd:dir,title:'Work',control,status,external,updatedAt:1});
 providers=providers?.(store)??{busy:new Set(),history:async()=>{},discover:async()=>({sessions:store.sessions(),warnings:[]}),status:(sid,s)=>store.save({...store.session(sid),status:s}),
  send:async(sid,body)=>{sends.push(body);store.save({...store.session(sid),status:'running'});}};
 const {server,queue}=createServer({store,providers});const token=store.desktopToken(),path='/sessions/'+encodeURIComponent(id);
 t.after(async()=>{await new Promise(r=>server.close(r));await providers.close?.();store.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(route,{method='GET',body}={})=>{
  if(!server.listening)await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const res=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,body:await res.json()};
 };
 const post=(requestId,text,extra={})=>call(path+'/messages',{method:'POST',body:{requestId,text,...extra}});
 const finish=()=>store.save({...store.session(id),status:'idle'});
 return {dir,store,id,path,call,post,finish,sends,queue,providers};
}

test('follow-ups sent during a turn are queued in order, then delivered one turn each, flipping queued in deltas',async t=>{
 const {store,id,path,call,post,finish,sends}=fixture(t);
 store.message(id,{id:'reply',role:'assistant',kind:'text',text:'Working',partial:true});
 const full=(await call(path)).body;
 const first=await post('q1','First follow-up');
 assert.equal(first.status,202);assert.equal(first.body.queued,true);
 assert.deepEqual([first.body.message.id,first.body.message.role,first.body.message.text,first.body.message.queued],['q1','user','First follow-up',true]);
 assert.equal((await post('q2','Second follow-up')).body.message.queued,true);
 assert.deepEqual(sends,[]);
 assert.equal((await call('/sessions')).body.sessions.find(s=>s.id===id).queued,2);
 const d1=(await call(`${path}?since=${full.cursor}`)).body;
 assert.equal(d1.delta,true);assert.equal(d1.session.queued,2);
 assert.deepEqual(d1.messages.filter(m=>m.role==='user').map(m=>[m.id,m.queued]),[['q1',true],['q2',true]]);
 // The turn ends: the oldest is delivered alone; the next waits for that turn.
 store.message(id,{id:'reply',role:'assistant',kind:'text',text:'Done',partial:false});finish();
 await until(()=>sends.length===1);await new Promise(r=>setTimeout(r,50));
 assert.deepEqual(sends.map(s=>[s.requestId,s.text]),[['q1','First follow-up']]);
 const d2=(await call(`${path}?since=${d1.cursor}`)).body,q1=d2.messages.find(m=>m.id==='q1');
 assert.equal(q1.queued,false);assert.ok(q1.completedAt>=store.messages(id).find(m=>m.id==='reply').completedAt);assert.equal(d2.session.queued,1);
 assert.deepEqual((await call(path)).body.messages.map(m=>m.id),['reply','q1','q2'],'delivered after the reply it waited for');
 assert.equal(store.db.prepare('SELECT state FROM requests WHERE id=?').get('q1').state,'submitted');
 finish();await until(()=>sends.length===2);
 assert.deepEqual(sends.map(s=>s.text),['First follow-up','Second follow-up']);
 assert.equal(store.sessionView(store.session(id)).queued,0);
 // Idle and empty: a message goes straight through, unqueued.
 finish();const direct=await post('q3','Now');assert.equal(direct.status,202);assert.equal(direct.body.queued,undefined);assert.equal(direct.body.message.queued,undefined);
 assert.equal(sends.length,3);
 assert.equal((await post('q1','First follow-up')).status,200,'a retried request stays a duplicate');
});

test('a queued follow-up can be cancelled; deltas remove it and it is never delivered',async t=>{
 const {store,id,path,call,post,finish,sends}=fixture(t);
 await post('keep','Keep me');await post('drop','Drop me');const before=(await call(path)).body;
 assert.deepEqual((await call(path+'/queue/cancel',{method:'POST',body:{id:'drop'}})).body,{ok:true});
 assert.deepEqual((await call(path+'/queue/cancel',{method:'POST',body:{id:'drop'}})).body,{ok:true},'cancelling twice is harmless');
 assert.equal((await call(path+'/queue/cancel',{method:'POST',body:{id:'missing'}})).status,404);
 const d=(await call(`${path}?since=${before.cursor}`)).body;assert.ok(d.removed.includes('drop'));assert.equal(d.session.queued,1);
 finish();await until(()=>sends.length===1);
 assert.deepEqual(sends.map(s=>s.requestId),['keep']);
 const late=await call(path+'/queue/cancel',{method:'POST',body:{id:'keep'}});assert.equal(late.status,409,'already delivered');
 finish();await new Promise(r=>setTimeout(r,50));assert.equal(sends.length,1);
 assert.ok(!store.messages(id).some(m=>m.id==='drop'));
});

test('a message sent while a question is pending waits for the question; other operations queue too',async t=>{
 const {store,id,post,finish,sends,providers}=fixture(t,{status:'idle'});
 createQuestion(store,id,[{title:'Which one?',options:['A','B']}]);
 const r=await post('after-question','Also do this');assert.equal(r.status,202);assert.equal(r.body.queued,true);
 store.save({...store.session(id),status:'error'});await new Promise(r=>setTimeout(r,50));assert.equal(sends.length,0,'held while the question is pending');
 cancelQuestions(store,id);providers.busy.add(id);finish();await new Promise(r=>setTimeout(r,50));assert.equal(sends.length,0,'held while busy');
 providers.busy.delete(id);await until(()=>sends.length===1);assert.equal(sends[0].text,'Also do this');
});

test('external and terminal sessions keep refusing input while busy; rate-limit pauses hold the queue',async t=>{
 const ext=fixture(t,{control:'resume',external:true});
 assert.equal((await ext.post('x','hi')).status,409);
 const live=fixture(t,{control:'external-live',status:'idle'});assert.equal((await live.post('x','hi')).status,409);
 const term=fixture(t,{control:'terminal',status:'idle'});assert.equal((await term.post('x','hi')).status,409);
 const f=fixture(t);await f.post('a','first');
 f.store.save({...f.store.session(f.id),status:'rate_limited'});await new Promise(r=>setTimeout(r,50));assert.equal(f.sends.length,0);
 // Sending again is a person choosing to go on: the queue is released in order.
 await f.post('b','second');await until(()=>f.sends.length===1);assert.equal(f.sends[0].requestId,'a');
 f.finish();await until(()=>f.sends.length===2);assert.equal(f.sends[1].requestId,'b');
});

test('end drops the queue, interrupt keeps it and delivers the next follow-up',async t=>{
 const sends=[];
 const f=fixture(t,{providers:store=>{const p=new Providers(store);p.discoverClaude=async()=>{};p.send=async(id,body)=>{sends.push(body.requestId);store.save({...store.session(id),status:'running'});};return p;}});
 await f.post('one','one');await f.post('two','two');
 await f.call(f.path+'/stop',{method:'POST'});await until(()=>sends.length===1);assert.deepEqual(sends,['one']);
 const before=(await f.call(f.path)).body;
 await f.call(f.path+'/end',{method:'POST'});
 assert.equal(f.store.session(f.id).status,'ended');assert.equal(f.store.sessionView(f.store.session(f.id)).queued,0);
 assert.ok((await f.call(`${f.path}?since=${before.cursor}`)).body.removed.includes('two'));
 assert.equal(f.store.db.prepare('SELECT state FROM requests WHERE id=?').get('two').state,'cancelled');
 await new Promise(r=>setTimeout(r,50));assert.deepEqual(sends,['one']);
});

test('provider echoes never claim a queued row, and Codex waits for an interrupted turn to wind down',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-queue-s-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.save({id:'s',provider:'codex',providerId:'s',status:'running'});
 for(const [id,queued] of [['sent',false],['waiting',true]]){store.claim(id,'s',{text:'yes'});store.message('s',{id,role:'user',kind:'text',text:'yes',...(queued?{queued:true}:{})});}
 store.userAcknowledgement('s',{id:'native',role:'user',kind:'text',text:'yes'});
 assert.deepEqual(store.messages('s').map(m=>[m.id,!!m.queued]),[['native',false],['waiting',true]]);
 const p=new Providers(store);t.after(()=>p.close());let active=true;p.rpc={dead:false,call:async()=>({thread:{status:{type:active?'active':'idle'}}}),close(){}};
 assert.equal(await p.queueReady('s'),false);active=false;assert.equal(await p.queueReady('s'),true);
});

test('artifacts carry the reply they belong to, stable across polls, and the hash changes when it does',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-files-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.save({id:'s',provider:'claude',status:'running',updatedAt:0});const now=Date.now(),folder=artifactDirectory(store,'s');
 const file=(name,at)=>{const path=join(folder,name);writeFileSync(path,'x');if(at)utimesSync(path,at/1000,at/1000);return path;};
 store.message('s',{id:'old',role:'assistant',kind:'text',text:'Earlier',completedAt:now-60_000});
 store.message('s',{id:'made',role:'assistant',kind:'text',text:'Here is the chart',completedAt:now+60_000});
 store.message('s',{id:'tool',role:'tool',kind:'Tool result',text:'ok'});
 file('chart.png');file('later.csv',now+90_000);
 store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run('up','s','photo.jpg',file('up-photo.jpg'),'image/jpeg');
 const get=q=>conversationReply(store,'s',new URL('http://x/sessions/s'+(q||'')));
 const first=get(),ids=Object.fromEntries(first.artifacts.map(a=>[a.name,a.messageId]));
 assert.deepEqual(ids,{'chart.png':'made','later.csv':null,'photo.jpg':null});
 assert.deepEqual(get().artifacts,first.artifacts,'stable across polls');
 const idle=get(`?since=${first.cursor}&artifacts=${first.artifactsHash}&images=${first.imagesHash}`);assert.equal(idle.artifacts,undefined);
 // A reply streaming after the file claims it; the delta carries the changed list.
 store.message('s',{id:'next',role:'assistant',kind:'text',text:'Saved the table',partial:true,createdAt:now+100_000});
 const changed=get(`?since=${idle.cursor}&artifacts=${idle.artifactsHash}&images=${idle.imagesHash}`);
 assert.notEqual(changed.artifactsHash,first.artifactsHash);assert.equal(changed.artifacts.find(a=>a.name==='later.csv').messageId,'next');
});

test('GET /usage reports Claude and Codex windows from rate-limit events, and the relay allows exactly /usage',async t=>{
 const now=Date.now(),inHour=Math.floor((now+3_600_000)/1000),inWeek=Math.floor((now+5*86_400_000)/1000);
 assert.equal(claudeUsage(null,{status:'allowed',utilization:0.5}),null,'no window type, nothing known');
 assert.deepEqual(codexUsage({rateLimits:{primary:{usedPercent:42,windowDurationMins:300,resetsAt:inHour},secondary:{usedPercent:130,windowDurationMins:10080,resetsAt:inWeek}}}),
  {fiveHour:{utilization:0.42,resetsAt:inHour*1000},sevenDay:{utilization:1,resetsAt:inWeek*1000}});
 assert.equal(codexUsage({}),null);
 const f=fixture(t,{status:'idle'});
 assert.deepEqual((await f.call('/usage')).body,{claude:null,codex:null});
 const dir=mkdtempSync(join(tmpdir(),'ar-usage-')),store=new Store(dir),p=new Providers(store);t.after(async()=>{await p.close();store.close();rmSync(dir,{recursive:true,force:true});});
 store.save({id:'claude:u',provider:'claude',providerId:'u',status:'running'});store.save({id:'codex:u',provider:'codex',providerId:'u',status:'running'});
 p.claudeEvent(store.session('claude:u'),{type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour',utilization:0.81,resetsAt:inHour}},true);
 p.claudeEvent(store.session('claude:u'),{type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'seven_day',resetsAt:inWeek}},true);
 p.codexEvent({},{method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:inHour}}}});
 const usage=accountUsage(store);
 assert.deepEqual(usage.claude.fiveHour,{utilization:0.81,resetsAt:inHour*1000});assert.deepEqual(usage.claude.sevenDay,{utilization:1,resetsAt:inWeek*1000});
 assert.deepEqual(usage.codex.fiveHour,{utilization:0.1,resetsAt:inHour*1000});assert.equal(usage.codex.sevenDay,null);
 for(const v of [usage.claude,usage.codex])assert.ok(v.updatedAt>=now);
 assert.deepEqual(accountUsage(store,now+2*3_600_000).codex,null,'a window past its reset is unknown again');
 assert.equal(accountUsage(store,now+2*3_600_000).claude.fiveHour,null);
 // Over HTTP the shape is the same.
 f.store.db.prepare('INSERT INTO settings VALUES (?,?)').run('usage:codex',JSON.stringify({fiveHour:{utilization:0.3,resetsAt:inHour*1000},sevenDay:null,updatedAt:now}));
 assert.deepEqual((await f.call('/usage')).body,{claude:null,codex:{fiveHour:{utilization:0.3,resetsAt:inHour*1000},sevenDay:null,updatedAt:now}});
 assert.equal(relayRoute('/usage'),true);
 for(const path of ['/usage/x','/usage?all=1','/usages','/x/usage'])assert.equal(relayRoute(path),false,path);
 assert.equal(relayRoute('/sessions/claude%3Aq/queue/cancel'),true);
});
