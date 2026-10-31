import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {Providers} from '../src/providers.mjs';
import {ReplyNotifier} from '../src/reply-notifications.mjs';
import {createServer} from '../src/server.mjs';
import {ClaudeAuth,parseCredentials,loginURL,readClaudeCredentials,AUTH_ERROR} from '../src/claude-auth.mjs';

const DAY=86_400_000,NOW=Date.UTC(2026,9,9);
const creds=(refreshToken,refreshTokenExpiresAt)=>JSON.stringify({claudeAiOauth:{accessToken:'access-'+refreshToken,refreshToken,expiresAt:NOW+3_600_000,refreshTokenExpiresAt,scopes:['user:inference']}});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'ar-claude-auth-')),file=join(dir,'credentials.json');
  const previous=process.env.AGENT_REMOTE_CLAUDE_CREDENTIALS;process.env.AGENT_REMOTE_CLAUDE_CREDENTIALS=file;
  writeFileSync(file,creds('refresh-a',NOW+20*DAY));
  const store=new Store(dir),providers=new Providers(store);providers.discoverClaude=async()=>{};
  const clock={now:NOW};providers.claudeAuth=new ClaudeAuth(providers,{now:()=>clock.now});
  const session={id:'claude:s',provider:'claude',providerId:'s',status:'idle',cwd:dir,control:'managed'};store.save(session);
  t.after(()=>{providers.close();store.close();rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.AGENT_REMOTE_CLAUDE_CREDENTIALS;else process.env.AGENT_REMOTE_CLAUDE_CREDENTIALS=previous;});
  return {dir,file,store,providers,auth:providers.claudeAuth,session,clock,write:(token,expiry)=>{writeFileSync(file,creds(token,expiry));providers.claudeAuth.cached=null;}};
}
// Mimics `claude auth login` when stdin is not a terminal: link, prompt, one line of input.
const fakeLogin=()=>spawn(process.execPath,['-e',`
  process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s\\nPaste code here if prompted > ");
  process.stdin.once('data',d=>{if(String(d).trim()==='good-code#s'){process.stdout.write('Login successful.\\n');process.exit(0);}process.stdout.write('OAuth error: invalid_grant\\n');process.exit(1);});`],{stdio:['pipe','pipe','pipe']});

test('credentials expose only expiry and a one-way fingerprint',()=>{
  const value=parseCredentials(creds('secret-refresh',NOW+DAY));
  assert.deepEqual(Object.keys(value).sort(),['accessExpiresAt','fingerprint','refreshExpiresAt']);
  assert.ok(!JSON.stringify(value).includes('secret-refresh'));assert.equal(value.refreshExpiresAt,NOW+DAY);
  assert.deepEqual(parseCredentials('{}'),{signedOut:true});
  const missing=readClaudeCredentials({env:{},run:()=>{throw Object.assign(new Error(),{status:44});},read:()=>{throw new Error('ENOENT');}});
  assert.deepEqual(missing,{signedOut:true},'no Keychain item and no file means signed out');
  assert.equal(readClaudeCredentials({env:{},run:()=>{throw Object.assign(new Error(),{status:36});},read:()=>creds('x',1)}),null,'a locked Keychain is unknown, never the stale plaintext file');
});
test('only Anthropic OAuth authorize links are relayed to the phone',()=>{
  assert.equal(loginURL('visit: https://claude.com/cai/oauth/authorize?code=true&state=1\nPaste'),'https://claude.com/cai/oauth/authorize?code=true&state=1');
  assert.equal(loginURL('visit: https://evil.example/oauth/authorize?x=1'),null);
  assert.equal(loginURL('visit: https://claude.com.evil.example/oauth/authorize?x=1'),null);
  assert.equal(loginURL('http://claude.ai/oauth/authorize?x=1'),null);
  for(const text of ['Failed to authenticate: OAuth session expired and could not be refreshed','Not logged in · Please run /login'])assert.match(text,AUTH_ERROR);
  assert.doesNotMatch('Claude usage limit reached.',AUTH_ERROR);
});
test('status warns three days ahead and reports a lapsed login',t=>{
  const {auth,clock,write}=fixture(t);
  assert.equal(auth.summary().state,'ok');
  clock.now=NOW+18*DAY;auth.cached=null;const soon=auth.status();
  assert.equal(soon.state,'expiring');assert.match(soon.alertKey,/^expiring:\d+:3$/);
  clock.now=NOW+19.5*DAY;auth.cached=null;assert.match(auth.status().alertKey,/:1$/,'a second alert in the final day');
  clock.now=NOW+21*DAY;auth.cached=null;assert.equal(auth.status().state,'expired');
  assert.ok(!('alertKey' in auth.summary()),'the phone never sees the fingerprint');
  write('refresh-b',NOW+48*DAY);assert.equal(auth.status().state,'ok');
});
test('an auth failure flags the session, restarts its process, and clears once signed in again',async t=>{
  const {store,providers,auth,session,write}=fixture(t);
  const child=spawn('sleep',['30'],{detached:true});providers.claude.set(session.id,child);
  const exited=new Promise(resolve=>child.once('exit',resolve));
  providers.claudeEvent(session,{type:'result',is_error:true,result:'Failed to authenticate: OAuth session expired and could not be refreshed'});
  assert.equal(store.session(session.id).authRequired,true);assert.equal(store.session(session.id).status,'error');
  await exited;
  assert.equal(auth.summary().state,'expired','failure is reported although the stored expiry is still in the future');
  assert.equal(new ClaudeAuth(providers,{now:()=>NOW}).summary().state,'expired','the failure survives a service restart');
  const idle=spawn('sleep',['30'],{detached:true});providers.claude.set('claude:other',idle);store.save({id:'claude:other',provider:'claude',status:'idle'});
  const idleExit=new Promise(resolve=>idle.once('exit',resolve));
  write('refresh-new',NOW+27*DAY);
  assert.equal(auth.summary().state,'ok');assert.equal(store.session(session.id).authRequired,false);
  await idleExit;
});
test('a phone can finish sign-in by relaying the code, and a wrong code is reported',async t=>{
  const {auth,write}=fixture(t);auth.spawnLogin=fakeLogin;
  const bad=await auth.startLogin();assert.match(bad.url,/^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  await assert.rejects(auth.submitCode(bad.id,'wrong-code'),/did not accept that code\. OAuth error: invalid_grant/);
  await assert.rejects(auth.submitCode(bad.id,'good-code#s'),/expired/,'a failed sign-in cannot be reused');
  const login=await auth.startLogin();assert.equal(auth.summary().login.state,'waiting');
  await assert.rejects(auth.submitCode(login.id,'has spaces'),/exactly as shown/);
  write('refresh-c',NOW+27*DAY);
  const result=await auth.submitCode(login.id,'good-code#s');
  assert.equal(result.ok,true);assert.equal(result.claudeAuth.login,null);
  const cancelled=await auth.startLogin();auth.cancelLogin(cancelled.id);await assert.rejects(auth.submitCode(cancelled.id,'good-code#s'),/expired/);
});
test('sign-in is reachable over the paired API and the session list carries auth status',async t=>{
  const {store,providers,auth}=fixture(t);auth.spawnLogin=fakeLogin;providers.discover=async()=>({warnings:[]});
  const {server,notifications}=createServer({store,providers});t.after(()=>notifications.close());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/claude/auth')).status,401);
  const headers={Authorization:'Bearer '+store.pair(store.pairCode(),'Phone').token,'Content-Type':'application/json'};
  assert.equal((await (await fetch(base+'/sessions',{headers})).json()).claudeAuth.state,'ok');
  const started=await (await fetch(base+'/claude/auth/login',{method:'POST',headers,body:'{}'})).json();
  const finished=await fetch(base+'/claude/auth/login/code',{method:'POST',headers,body:JSON.stringify({id:started.id,code:'good-code#s'})});
  assert.equal(finished.status,200);assert.equal((await finished.json()).ok,true);
});
test('phones are alerted once per expiry threshold and once per lapsed login',async t=>{
  const {dir,store,providers,auth,clock}=fixture(t);const sent=[];
  const n=new ReplyNotifier(store,{...providers,claudeAuth:auth,discover:async()=>{},history:async()=>{},sessions:()=>[]},{send:async(d,s,alert)=>sent.push(alert.kind+':'+alert.body.slice(0,20).trim())});t.after(()=>n.close());
  writeFileSync(join(dir,'push-config.json'),JSON.stringify({keyPath:'key',teamId:'team',keyId:'key',topics:['com.test']}));
  const d=store.createDevice('phone');n.register(d.token,{token:'f'.repeat(64),topic:'com.test',environment:'development'});
  await n.tick();assert.deepEqual(sent,[]);
  clock.now=NOW+18*DAY;auth.cached=null;await n.tick();await n.tick();
  clock.now=NOW+19.5*DAY;auth.cached=null;await n.tick();
  clock.now=NOW+21*DAY;auth.cached=null;await n.tick();await n.tick();
  assert.deepEqual(sent,['auth:Claude’s sign-in on','auth:Claude’s sign-in on','auth:Claude is signed out']);
});
test('a shared terminal whose login expired asks for sign-in, then hands the chat back once signed in',async t=>{
  const {dir,store,providers,auth,write,clock}=fixture(t);
  const id='claude:term',transcript=join(dir,'term.jsonl');providers.claudeActivity=async()=>[];
  const terminal={startedAt:NOW-60_000,ended:false,prompts:new Map(),closed:0,async lines(){return ['❯ ','─'.repeat(20)];},close:async function(){this.closed++;this.ended=true;}};
  providers.terminals.set(id,terminal);
  store.save({id,provider:'claude',providerId:'term',transcript,status:'idle',control:'terminal',terminal:true,cwd:dir});
  const row=(type,extra,at)=>JSON.stringify({type,timestamp:new Date(at).toISOString(),message:{role:type,content:[{type:'text',text:extra.text||'ok'}]},...extra});
  // A failure from before this terminal started (an old resumed transcript) is ignored.
  writeFileSync(transcript,[row('user',{},NOW-120_000),row('assistant',{isApiErrorMessage:true,error:'authentication_failed',text:'Login expired · Please run /login'},NOW-100_000),row('user',{},NOW-90_000)].join('\n')+'\n');
  await providers.history(id);assert.equal(store.session(id).authRequired,undefined);assert.equal(auth.status().state,'ok');
  writeFileSync(transcript,[row('user',{},NOW-10_000),row('assistant',{isApiErrorMessage:true,error:'authentication_failed',text:'Login expired · Please run /login'},NOW-5_000)].join('\n')+'\n');
  await providers.history(id);assert.equal(store.session(id).authRequired,true);assert.equal(auth.status().state,'expired');
  assert.equal(terminal.closed,0);
  // Signing in (from the phone or anywhere) ends the stale idle terminal so the chat resumes with the new login.
  clock.now+=1000;write('refresh-b',NOW+30*DAY);auth.status();
  assert.equal(terminal.closed,1);assert.equal(store.session(id).authRequired,false);
});
test('a terminal someone typed into at the Mac after the failure is left alone',async t=>{
  const {providers,auth,write,clock}=fixture(t);
  const terminal={startedAt:NOW-60_000,ended:false,authFailedAt:NOW-1000,desktopInputAt:NOW,closed:0,close:async function(){this.closed++;}};
  providers.terminals.set('claude:term',terminal);auth.noteFailure('claude:s');
  clock.now+=1000;write('refresh-b',NOW+30*DAY);auth.status();assert.equal(terminal.closed,0);
});
