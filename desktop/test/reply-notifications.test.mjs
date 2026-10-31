import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Store} from '../src/store.mjs';import {ReplyNotifier} from '../src/reply-notifications.mjs';import {createQuestion,resolveQuestion,pendingQuestions} from '../src/questions.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ar-push-')),store=new Store(dir);let sent=[];const n=new ReplyNotifier(store,{discover:async()=>{},history:async()=>{}},{send:async(d,s,alert)=>sent.push(alert.kind==='question'?'question:'+s.id:s.id)});t.after(()=>{n.close();store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,n,sent};}
test('push setup is explicit and registrations belong to paired devices',t=>{
 const {dir,store,n}=fixture(t);const d=store.createDevice('phone');assert.throws(()=>n.register(d.token,{enabled:true}),/Apple Push setup/);
 writeFileSync(join(dir,'push-config.json'),JSON.stringify({keyPath:'/not-read-in-test',teamId:'team',keyId:'key',topics:['com.test']}));
 assert.throws(()=>n.register('wrong',{enabled:false}),/Pair this iPhone/);
 assert.throws(()=>n.register(d.token,{token:'f'.repeat(64),topic:'evil',environment:'development'}),/Invalid push/);
 assert.equal(n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'development'}).enabled,true);
 assert.equal(n.register(d.token,{enabled:false}).enabled,false);
});
test('completed replies notify once, historical and streaming replies do not, revoked devices stop',async t=>{
 const {dir,store,n,sent}=fixture(t);const d=store.createDevice('phone');writeFileSync(join(dir,'push-config.json'),JSON.stringify({keyPath:'key',teamId:'team',keyId:'key',topics:['com.test']}));
 store.save({id:'s',provider:'codex',status:'idle'});store.message('s',{id:'old',role:'assistant',kind:'text',text:'Old',completedAt:1});n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'development'});
 await n.tick();assert.equal(sent.length,0);
 store.save({...store.session('s'),status:'running'});store.message('s',{id:'new',role:'assistant',kind:'text',text:'New',completedAt:2});await n.tick();assert.equal(sent.length,0);
 store.save({...store.session('s'),status:'idle'});await n.tick();await n.tick();assert.deepEqual(sent,['s']);
 store.db.prepare('DELETE FROM devices WHERE id=?').run(d.deviceId);store.message('s',{id:'next',role:'assistant',kind:'text',text:'Next',completedAt:3});await n.tick();assert.equal(sent.length,1);
});

test('a pending question notifies once and covers the reply that introduced it',async t=>{
 const {dir,store,n,sent}=fixture(t);const d=store.createDevice('phone');writeFileSync(join(dir,'push-config.json'),JSON.stringify({keyPath:'key',teamId:'team',keyId:'key',topics:['com.test']}));
 store.save({id:'s',provider:'claude',status:'idle',control:'managed'});n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'development'});
 store.save({...store.session('s'),status:'waiting'});store.message('s',{id:'intro',role:'assistant',kind:'text',text:'Before I continue…',completedAt:5});
 const q=createQuestion(store,'s',[{question:'Which option?',options:['A','B']}],{native:true});
 await n.tick();assert.deepEqual(sent,['question:s']);
 await n.tick();assert.deepEqual(sent,['question:s'],'the same question is not repeated');
 resolveQuestion(store,q,{'0':'A'});store.save({...store.session('s'),status:'idle'});await n.tick();
 assert.deepEqual(sent,['question:s'],'the reply shown with the question does not alert again');
 store.message('s',{id:'reply',role:'assistant',kind:'text',text:'Done.',completedAt:6});await n.tick();assert.deepEqual(sent,['question:s','s']);
 const again=createQuestion(store,'s',[{question:'And now?',options:['C','D']}],{native:true,terminal:true,screen:true});await n.tick();assert.deepEqual(sent,['question:s','s','question:s']);
 assert.equal(pendingQuestions(store,'s')[0].id,again.id);
 n.register(d.token,{enabled:false});assert.equal(store.db.prepare('SELECT count(*) AS n FROM push_question_receipts').get().n,0);
});
test('shared terminals and desktop clients are refreshed when their transcript changes',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-push-terminal-')),store=new Store(dir);const refreshed=[];
 const n=new ReplyNotifier(store,{discover:async()=>{},history:async id=>{refreshed.push(id);}},{send:async()=>{}});
 t.after(()=>{n.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const d=store.createDevice('phone');writeFileSync(join(dir,'push-config.json'),JSON.stringify({keyPath:'key',teamId:'team',keyId:'key',topics:['com.test']}));n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'development'});
 const transcript=join(dir,'t.jsonl');writeFileSync(transcript,'{}\n');
 store.save({id:'claude:t',provider:'claude',status:'running',control:'terminal',terminal:true,external:false,transcript});
 store.save({id:'claude:m',provider:'claude',status:'idle',control:'managed',external:false});
 await n.tick();assert.deepEqual(refreshed,['claude:t']);
 await n.tick();assert.deepEqual(refreshed,['claude:t'],'unchanged transcript is not re-read');
 await new Promise(r=>setTimeout(r,20));writeFileSync(transcript,'{}\n{}\n');await n.tick();assert.deepEqual(refreshed,['claude:t','claude:t']);
});

test('without a local Apple key, alerts go through the relay\'s sender and unregistered tokens are dropped',async t=>{
 const {generateKeyPairSync}=await import('node:crypto');const {createRelay,pushConfig}=await import('../../relay/src/server.mjs');
 const {RelayState}=await import('../src/relay-state.mjs');const {DesktopRelay}=await import('../src/relay-client.mjs');const {ALERTS}=await import('../src/reply-notifications.mjs');
 const pem=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});const apple=[];
 const relay=createRelay({push:{...pushConfig({APNS_KEY_P8:pem,APNS_KEY_ID:'K',APNS_TEAM_ID:'T',APNS_TOPICS:'com.test'}),send:async r=>{apple.push(r);return r.token.startsWith('0')?{status:410,reason:'Unregistered'}:{status:200,reason:''};}}});
 await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(join(tmpdir(),'ar-push-relay-')),store=new Store(dir),state=new RelayState(store);state.configure(`ws://127.0.0.1:${relay.server.address().port}`);
 const desktop=new DesktopRelay({store,state,apiURL:'http://127.0.0.1:9'}),n=new ReplyNotifier(store,{discover:async()=>{},history:async()=>{}},{relay:desktop});
 t.after(async()=>{n.close();desktop.close();await relay.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const d=store.createDevice('phone');
 assert.equal(n.status().configured,false);assert.throws(()=>n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'production'}),/Apple Push setup/);
 const connected=new Promise(r=>desktop.on('status',s=>{if(s==='connected')r();}));desktop.start();await connected;
 assert.equal(n.status().configured,true);
 assert.throws(()=>n.register(d.token,{token:'f'.repeat(64),topic:'com.other',environment:'production'}),/Invalid push/);
 n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'production'});
 store.save({id:'s',provider:'codex',status:'idle'});store.message('s',{id:'r',role:'assistant',kind:'text',text:'Private reply text',completedAt:1});
 await n.tick();assert.equal(apple.length,1);
 const payload=JSON.parse(apple[0].payload);assert.deepEqual(payload,{aps:{alert:{title:ALERTS.reply.title,body:ALERTS.reply.body},sound:'default'},hostId:store.hostId,sessionId:'s',kind:'reply'});
 assert.equal(apple[0].payload.includes('Private reply text'),false);assert.equal(apple[0].environment,'production');
 // A relay-paired phone also gets the sealed content, through the real relay, still without readable text.
 const {openPush}=await import('../src/reply-notifications.mjs');const secret=Buffer.alloc(32,9);store.db.prepare('INSERT INTO relay_devices VALUES (?,?)').run(d.deviceId,secret.toString('base64'));
 store.message('s',{id:'r1',role:'assistant',kind:'text',text:'Private second reply',completedAt:1.5});await n.tick();assert.equal(apple.length,2);
 const rich=JSON.parse(apple[1].payload);assert.equal(rich.aps['mutable-content'],1);assert.deepEqual(rich.aps.alert,payload.aps.alert);assert.equal(apple[1].payload.includes('Private'),false);
 assert.equal(openPush(secret,store.hostId,'s','reply',rich.e2e).body,'Private second reply');apple.splice(1,1);
 store.db.prepare('UPDATE push_devices SET token=?').run('0'.repeat(64));store.message('s',{id:'r2',role:'assistant',kind:'text',text:'Another',completedAt:2});
 await n.tick();assert.equal(apple.length,2);assert.equal(n.devices().length,0,'an unregistered token is deleted');
 desktop.close();await assert.rejects(n.push({token:'f'.repeat(64),topic:'com.test',environment:'production'},{id:'s'}),/not connected/);
 assert.equal(n.status().configured,true,'remembered while the relay reconnects');
});

test('rich alert content is sealed for each device with its relay secret; Apple sees only ciphertext and the generic text',async t=>{
 const {openPush,sealPush,previewLine,E2E_MAX}=await import('../src/reply-notifications.mjs');const {randomBytes}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'ar-push-e2e-')),store=new Store(dir),relayed=[];
 const relay={pushTopics:()=>['com.test'],push:async m=>{relayed.push(m);return {ok:true,status:200};}};
 const n=new ReplyNotifier(store,{discover:async()=>{},history:async()=>{}},{relay});t.after(()=>{n.close();store.close();rmSync(dir,{recursive:true,force:true});});
 store.db.exec('CREATE TABLE IF NOT EXISTS relay_devices (id TEXT PRIMARY KEY, secret TEXT NOT NULL)');
 const phone=store.createDevice('phone'),direct=store.createDevice('direct'),secret=randomBytes(32);
 store.db.prepare('INSERT INTO relay_devices VALUES (?,?)').run(phone.deviceId,secret.toString('base64'));
 for(const d of [phone,direct])n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'production'});
 store.save({id:'s',provider:'claude',status:'idle',control:'managed',title:'Fix the  login\nbug'});
 store.message('s',{id:'r',role:'assistant',kind:'text',text:'## Summary\n\n```js\nsecret()\n```\nI **fixed** the `token` refresh in [auth.mjs](src/auth.mjs). Tests pass now.\nSecond line',completedAt:1});
 await n.tick();assert.equal(relayed.length,2);
 const [sealed,plain]=[relayed.find(m=>m.e2e),relayed.find(m=>!m.e2e)];
 assert.deepEqual(sealed.alert,{kind:'reply',title:'Agent Remote',body:'Your agent has replied.'});assert.equal(sealed['mutable-content'],1);
 assert.equal(plain['mutable-content'],undefined,'a directly paired device (no relay secret) gets the generic alert only');
 assert.equal(JSON.stringify(sealed).includes('fixed'),false);assert.equal(JSON.stringify(sealed).includes('login'),false);assert.ok(sealed.e2e.length<=E2E_MAX);
 assert.deepEqual(openPush(secret,store.hostId,'s','reply',sealed.e2e),{v:1,kind:'reply',session:'s',title:'Fix the login bug',body:'I fixed the token refresh in auth.mjs. Tests pass now.',reply:true});
 assert.throws(()=>openPush(secret,store.hostId,'other','reply',sealed.e2e),'bound to its session');assert.throws(()=>openPush(secret,store.hostId,'s','question',sealed.e2e),'and kind');
 assert.throws(()=>openPush(randomBytes(32),store.hostId,'s','reply',sealed.e2e),'and to the device');
 // A question: its text and up to three option labels, answerable from the notification when it has one item.
 store.save({...store.session('s'),status:'waiting'});
 const q=createQuestion(store,'s',[{question:'Which database should I use?',options:['Postgres','SQLite','DynamoDB','Something else']}],{native:true});
 await n.tick();const asked=relayed.slice(2).find(m=>m.e2e);assert.equal(asked.alert.kind,'question');
 assert.deepEqual(openPush(secret,store.hostId,'s','question',asked.e2e),{v:1,kind:'question',session:'s',title:'Fix the login bug',body:'Which database should I use?',question:{id:q.id,item:'0',options:['Postgres','SQLite','DynamoDB']}});
 // Oversized content is shrunk to fit: option buttons go first (labels are the answer, never truncated), then the text.
 const big={v:1,kind:'question',session:'s',title:'T'.repeat(64),body:'é'.repeat(200),question:{id:q.id,item:'0',options:['x'.repeat(160),'y'.repeat(160),'z'.repeat(160)]}};
 const box=n.e2e({device:phone.deviceId},{id:'s'},{kind:'question'},{...big,body:'🙂'.repeat(200)});assert.ok(box.length<=E2E_MAX);
 const shrunk=openPush(secret,store.hostId,'s','question',box);assert.deepEqual(shrunk.question.options,[]);assert.equal(shrunk.question.id,q.id);
 assert.equal(n.e2e({device:phone.deviceId},{id:'s'},{kind:'question'},big).length<=E2E_MAX,true);
 // Shared terminals cannot take a typed reply from the notification; multi-item questions only open the chat.
 store.save({id:'t',provider:'claude',status:'idle',control:'terminal',terminal:true,title:'Shell'});store.message('t',{id:'tr',role:'assistant',kind:'text',text:'Done.',completedAt:2});
 assert.equal(n.replyContent(store.sessionView(store.session('t'))).reply,false);
 assert.equal(n.questionContent(store.session('s'),{id:'m',questions:[{id:'a',title:'One?',options:[]},{id:'b',title:'Two?',options:[]}]}).question,undefined);
 assert.equal(n.questionContent(store.session('s'),{id:'m',questions:[{id:'a',title:'One?',options:[]}]}).body,'One?');
 // The direct (local Apple key) path builds the same payload.
 const direct2=JSON.parse(n.apnsPayload({device:phone.deviceId},{id:'s'},{kind:'reply',title:'Agent Remote',body:'Your agent has replied.'},{v:1,kind:'reply',session:'s',title:'x',body:'y',reply:true}));
 assert.equal(direct2.aps['mutable-content'],1);assert.deepEqual(openPush(secret,store.hostId,'s','reply',direct2.e2e).body,'y');
 assert.equal(JSON.parse(n.apnsPayload({device:direct.deviceId},{id:'s'},{kind:'reply',title:'Agent Remote',body:'Your agent has replied.'},{v:1})).e2e,undefined);
 assert.equal(previewLine('```\ncode only\n```'),'');assert.equal(previewLine('> **Note:** see <b>this</b>'),'Note: see this');
 assert.equal(sealPush(secret,'h','s','reply',{a:1},Buffer.alloc(12)),sealPush(secret,'h','s','reply',{a:1},Buffer.alloc(12)));
});
