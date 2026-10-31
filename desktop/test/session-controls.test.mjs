import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {Providers} from '../src/providers.mjs';import {SessionControls,isRateLimitError,codexWindows} from '../src/session-controls.mjs';
function fixture(t,provider='codex'){
 const dir=mkdtempSync(join(tmpdir(),'ar-controls-')),store=new Store(dir),p=new Providers(store);const id=provider+':test';
 store.save({id,provider,providerId:'test',cwd:dir,title:'Work',status:'idle',external:false});p.discoverClaude=async()=>{};
 t.after(async()=>{await p.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,p,c:p.controls,id,dir};
}
test('rate limits are distinct from context, auth, budgets and ambiguous network failures',()=>{
 assert.equal(isRateLimitError({codexErrorInfo:'usageLimitExceeded'}),true);
 assert.equal(isRateLimitError({message:"You've hit your limit"}),true);
 for(const error of [{codexErrorInfo:'contextWindowExceeded'},{codexErrorInfo:'sessionBudgetExceeded'},{message:'network timeout; outcome unknown'},{message:'unauthorized'}])assert.equal(isRateLimitError(error),false);
 assert.deepEqual(codexWindows({rateLimits:{primary:{usedPercent:70,resetsAt:1900000000,windowDurationMins:300}}})[0].resetAt,1900000000000);
});
test('token events expose last context separately from cumulative usage and compaction',t=>{
 const {store,p,id}=fixture(t);
 p.codexEvent({}, {method:'thread/tokenUsage/updated',params:{threadId:'test',tokenUsage:{last:{totalTokens:100},total:{totalTokens:900},modelContextWindow:1000}}});
 assert.equal(store.session(id).usage.contextTokens,100);assert.equal(store.session(id).usage.totalTokens,900);
 p.codexEvent({}, {method:'item/completed',params:{threadId:'test',item:{type:'contextCompaction',id:'c'}}});assert.equal(store.session(id).compaction.state,'complete');
});
test('native provider retries are not duplicated, terminal rate failures prompt by default',t=>{
 const {store,p,c,id}=fixture(t);c.rememberSubmission(id,{text:'work',requestId:'first'});
 const params={threadId:'test',turnId:'t',error:{message:'limit',codexErrorInfo:'rateLimitExceeded'}};
 p.codexEvent({}, {method:'error',params:{...params,willRetry:true}});assert.equal(store.session(id).rateLimit,null);
 p.codexEvent({}, {method:'error',params:{...params,willRetry:false}});assert.equal(store.session(id).rateLimit.decision,'ask');
 p.codexEvent({}, {method:'turn/completed',params:{threadId:'test',turn:{id:'t',status:'failed',error:params.error}}});assert.equal(store.session(id).status,'rate_limited');
});
test('retry is once per confirmed reset, carries consent through another rate limit, and can be cancelled',async t=>{
 const {store,p,c,id}=fixture(t,'claude');const future=Date.now()+100000;
 c.rememberSubmission(id,{text:'original',requestId:'first',attachments:['a']});c.accepted(id);
 c.limited(id,{message:'rate limit'},{resetAt:future});c.decide(id,'scheduled');let calls=[];
 p.send=async(s,input)=>{calls.push(input);c.rememberSubmission(s,input);c.accepted(s);c.patch(s,{status:'running'});};
 await c.tick(future-1);assert.equal(calls.length,0);
 await Promise.all([c.tick(future+6000),c.tick(future+6000)]);assert.equal(calls.length,1);assert.match(calls[0].text,/Continue the previous request/);assert.deepEqual(calls[0].attachments,[]);
 c.limited(id,{message:'rate limit'},{resetAt:future+200000});assert.equal(store.session(id).rateLimit.decision,'scheduled');
 c.decide(id,'cancelled');await c.tick(future+300000);assert.equal(calls.length,1);
});
test('a rejected submission retains original prompt and attachments; unknown reset never invents a retry time',async t=>{
 const {p,c,id,store}=fixture(t,'claude');c.setPreferences({autoRetry:true});c.rememberSubmission(id,{text:'original',attachments:['file'],requestId:'a'});
 c.limited(id,{message:'rate limit'},{rejected:true});let sent;p.send=async(_,input)=>{sent=input;c.patch(id,{status:'running'});};
 await c.tick(Date.now()+999999);assert.equal(sent,undefined);
 c.patch(id,{rateLimit:{...store.session(id).rateLimit,resetAt:Date.now()+70000}});await c.tick(Date.now()+90000);
 assert.equal(sent.text,'original');assert.deepEqual(sent.attachments,['file']);
});
test('restart does not replay an ambiguous in-flight retry',async t=>{
 const {store,p,c,id}=fixture(t);c.patch(id,{rateLimit:{id:'r',decision:'retrying'},status:'submitting'});c.close();p.controls=new SessionControls(p);
 assert.equal(store.session(id).rateLimit.decision,'ask');assert.equal(store.session(id).status,'interrupted');
});
test('historical Claude rate failures do not reschedule work',t=>{
 const {store,p,id}=fixture(t,'claude');p.claudeEvent(store.session(id),{type:'assistant',error:'rate_limit',message:{id:'a',content:[]}});
 assert.equal(store.session(id).rateLimit,undefined);
});
test('model and effort changes are validated and used on the next Codex turn',async t=>{
 const {store,p,c,id}=fixture(t);const calls=[];p.loaded.add('test');
 p.codex=async()=>({call:async(method,params)=>{calls.push({method,params});if(method==='model/list')return {data:[{model:'chosen',displayName:'Chosen',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};return {};}});
 await assert.rejects(c.configure(id,{model:'chosen',effort:'ultra'}),/does not support/);
 await c.configure(id,{model:'chosen',effort:'high'});await p.send(id,{text:'hi',requestId:'r'});
 const turn=calls.find(c=>c.method==='turn/start');assert.equal(turn.params.model,'chosen');assert.equal(turn.params.effort,'high');assert.equal(store.session(id).model,'chosen');
});
test('handoff preserves history and cwd, links services, and deduplicates retries',async t=>{
 const {store,p,c,id,dir}=fixture(t);p.history=async()=>{};p.send=async()=>{};
 store.message(id,{id:'u',role:'user',kind:'text',text:'Keep this decision'});
 const a=await c.handoff(id,{provider:'claude',requestId:'h'}),b=await c.handoff(id,{provider:'claude',requestId:'h'});
 assert.equal(a.session.id,b.session.id);assert.equal(a.session.cwd,dir);assert.equal(a.session.handoffFrom,id);assert.equal(store.session(id).handoffTo,a.session.id);
 const file=store.db.prepare('SELECT path FROM artifacts WHERE session=?').get(a.session.id);assert.match(readFileSync(file.path,'utf8'),/Keep this decision/);assert.ok(store.session(id));
});
test('Claude rate event waits for the final result and preserves the reported reset',t=>{
 const {store,p,id}=fixture(t,'claude');const session=store.session(id);const reset=Date.now()/1000+3600;
 p.claudeEvent(session,{type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:reset}},true);
 assert.equal(store.session(id).rateLimit,undefined);
 p.claudeEvent(session,{type:'result',is_error:true,result:'Stopped'},true);
 assert.equal(store.session(id).rateLimit.resetAt,reset*1000);assert.equal(store.session(id).rateLimit.decision,'ask');
});
test('service default replaces an old model and effort rather than inheriting it',async t=>{
 const {store,p,c,id}=fixture(t);p.codex=async()=>({call:async()=>({data:[{model:'default-model',displayName:'Default',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]})});
 store.save({...store.session(id),model:'old',effort:'high'});await c.configure(id,{model:'',effort:''});
 assert.equal(store.session(id).model,'default-model');assert.equal(store.session(id).effort,'medium');
});
test('Claude usage counts cached input but not cumulative input as the context window',t=>{
 const {store,p,id}=fixture(t,'claude');p.claudeEvent(store.session(id),{type:'assistant',message:{id:'u',usage:{input_tokens:100,cache_read_input_tokens:200,cache_creation_input_tokens:300},content:[]}},true);
 p.claudeEvent(store.session(id),{type:'result',is_error:false,modelUsage:{opus:{contextWindow:1000,inputTokens:2000,outputTokens:500}}},true);
 assert.equal(store.session(id).usage.contextTokens,600);assert.equal(store.session(id).usage.contextWindow,1000);assert.equal(store.session(id).usage.totalTokens,2500);
});
test('an existing session can continue after a confirmed pause even without a recorded phone prompt',async t=>{
 const {p,c,id}=fixture(t,'claude');const now=Date.now()+120000;
 c.limited(id,{message:'usage limit'},{resetAt:now-10000});c.decide(id,'scheduled');let sent;
 p.send=async(_,input)=>{sent=input;};await c.tick(now);assert.match(sent.text,/Continue the previous request/);
});

test('handoff of a long conversation starts the new service instead of failing on context recall',async t=>{
 const {store,p,c,id}=fixture(t);p.history=async()=>{};
 const written=[];p.startClaude=s=>{const child={pid:4194304,kill(){},on(){},once(){},settingsRevision:0,stdin:{write:(data,cb)=>{written.push(JSON.parse(data));cb();},on(){},end(){}}};p.claude.set(s.id,child);return child;};
 for(let n=0;n<60;n++)store.message(id,{id:'u'+n,role:'user',kind:'text',text:`Decision ${n}: `+'detail '.repeat(30)});
 const {session}=await c.handoff(id,{provider:'claude',requestId:'long'});
 assert.doesNotMatch(session.note||'',/short query/);assert.equal(session.status,'running');
 assert.match(written[0].message.content[0].text,/Decision 59/);
});
