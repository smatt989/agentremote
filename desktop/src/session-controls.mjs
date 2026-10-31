import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const fail = (message,status=409) => Object.assign(new Error(message),{status});
const active = s => ['running','submitting','waiting','compacting'].includes(s.status);
const millis = n => Number.isFinite(n) && n > 0 ? (n < 1e12 ? n*1000 : n) : null;
export const isRateLimitError = error => ['usageLimitExceeded','rateLimitExceeded'].includes(error?.codexErrorInfo) ||
  error?.error === 'rate_limit' || /(?:rate.?limit (?:exceeded|reached)|usage limit|you(?:'ve| have) (?:hit|reached) your limit|too many requests)/i.test(error?.message || '');
export function codexWindows(value) {
  const buckets = value?.rateLimitsByLimitId ? Object.values(value.rateLimitsByLimitId) : value?.rateLimits ? [value.rateLimits] : [];
  return buckets.flatMap(b => ['primary','secondary'].flatMap(key => b[key] ? [{name:`${b.limitName || b.limitId || 'Codex'} · ${b[key].windowDurationMins ? b[key].windowDurationMins+' min' : key}`,usedPercent:b[key].usedPercent,resetAt:millis(b[key].resetsAt)}] : []));
}
// GET /usage: the account's 5-hour and weekly windows per service, from the latest rate-limit information already seen
// (Claude's rate_limit_event, Codex's account/rateLimits). Kept in settings so it survives a restart; a window whose
// reset time has passed is unknown again (null), and a service with no known window is null.
const unit = n => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
const usageWindow = (utilization, resetsAt) => unit(utilization) === null ? null : { utilization: unit(utilization), resetsAt: millis(resetsAt) };
export function codexUsage(value) {
  const all = value?.rateLimitsByLimitId ? Object.values(value.rateLimitsByLimitId) : [];
  const bucket = value?.rateLimits || all.find(b => b?.limitId === 'codex') || all[0];
  const out = { fiveHour: null, sevenDay: null };
  for (const key of ['primary', 'secondary']) {
    const w = bucket?.[key]; if (!w) continue;
    const mins = w.windowDurationMins, slot = Number.isFinite(mins) ? (mins <= 360 ? 'fiveHour' : mins >= 5 * 1440 ? 'sevenDay' : null) : key === 'primary' ? 'fiveHour' : 'sevenDay';
    if (slot) out[slot] = usageWindow(w.usedPercent / 100, w.resetsAt);
  }
  return out.fiveHour || out.sevenDay ? out : null;
}
export function claudeUsage(previous, info, now = Date.now()) {
  const slot = { five_hour: 'fiveHour', seven_day: 'sevenDay' }[info?.rateLimitType]; if (!slot) return null;
  const window = usageWindow(Number.isFinite(info.utilization) ? info.utilization : info.status === 'rejected' ? 1 : NaN, info.resetsAt); if (!window) return null;
  return { fiveHour: previous?.fiveHour ?? null, sevenDay: previous?.sevenDay ?? null, [slot]: window, updatedAt: now };
}
export function accountUsage(store, now = Date.now()) {
  const read = key => { try { return JSON.parse(store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || 'null'); } catch { return null; } };
  const current = w => w && (!w.resetsAt || w.resetsAt > now) ? w : null;
  const view = value => { if (!value) return null; const v = { fiveHour: current(value.fiveHour), sevenDay: current(value.sevenDay), updatedAt: value.updatedAt }; return v.fiveHour || v.sevenDay ? v : null; };
  return { claude: view(read('usage:claude')), codex: view(read('usage:codex')) };
}
export class SessionControls {
  constructor(providers) {
    this.providers=providers;this.store=providers.store;this.limitCache=null;this.polling=null;this.tickBusy=false;this.claudeFailures=new Map();
    this.timer=setInterval(()=>this.tick().catch(()=>{}),15000);this.timer.unref();
    for(const s of this.store.sessions())if(s.rateLimit?.decision==='retrying')this.patch(s.id,{rateLimit:{...s.rateLimit,decision:'ask',message:'The Mac restarted during a retry. Check the conversation before continuing.'},status:'interrupted'});
  }
  close(){clearInterval(this.timer);}
  read(key,fallback){const r=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):fallback;}
  write(key,value){this.store.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  patch(id,values){const s=this.store.session(id);if(s)this.store.save({...s,...values});}
  preferences(){return this.read('sessionPreferences',{autoRetry:false});}
  setPreferences(value){if(typeof value.autoRetry!=='boolean')throw fail('Choose whether to retry automatically.',400);this.write('sessionPreferences',{autoRetry:value.autoRetry});return this.preferences();}
  async models(provider){
    if(provider==='claude')return {models:['opus','sonnet','haiku'].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),efforts:['low','medium','high','xhigh','max']})),note:'Aliases follow your Claude installation. Model support for effort varies.'};
    const rpc=await this.providers.codex();const models=[];let cursor;
    do{const page=await rpc.call('model/list',{limit:100,cursor});models.push(...page.data.filter(m=>!m.hidden).map(m=>({id:m.model,name:m.displayName,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort),defaultEffort:m.defaultReasoningEffort,isDefault:m.isDefault})));cursor=page.nextCursor;}while(cursor);
    return {models};
  }
  async configure(id,value){
    const s=this.store.session(id);if(!s)throw fail('Session not found.',404);
    if(s.control==='external-live'||s.terminal)throw fail('Change model settings in the owning terminal, or end it and resume here.');
    let model=typeof value.model==='string'?value.model.trim():null,effort=value.effort;
    if(model===null||model.length>200||typeof effort!=='string'||!['','none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw fail('Invalid model or effort.',400);
    if(s.provider==='codex'&&!s.localProvider){
      const catalog=await this.models('codex');
      const entry=model?catalog.models.find(m=>m.id===model):catalog.models.find(m=>m.isDefault);
      if(!entry)throw fail('This model is not available in your Codex installation.',400);
      if(effort&&!entry.efforts.includes(effort))throw fail('This model does not support that effort.',400);
      model=entry.id;effort=effort||entry.defaultEffort||'';
    }
    if(s.provider==='claude'&&effort&&!['low','medium','high','xhigh','max'].includes(effort))throw fail('Claude does not support that effort.',400);
    this.patch(id,{model:model||null,effort:effort||null,settingsRevision:(s.settingsRevision||0)+1});return {session:this.store.sessionView(this.store.session(id))};
  }
  rememberSubmission(id,input){const limit=this.store.session(id)?.rateLimit;this.write('session-run:'+id,{input,accepted:false,autoRetry:limit?.decision==='retrying',attempts:limit?.attempts||0});this.patch(id,{rateLimit:null});}
  accepted(id){const job=this.read('session-run:'+id,null);if(job)this.write('session-run:'+id,{...job,accepted:true});}
  async refreshLimits(){
    if(this.polling)return this.polling;
    this.polling=(async()=>{try{const result=await(await this.providers.codex()).call('account/rateLimits/read',{});this.limitCache={windows:codexWindows(result),updatedAt:Date.now()};this.noteCodexUsage(result);return this.limitCache;}finally{this.polling=null;}})();return this.polling;
  }
  noteCodexUsage(value){const usage=codexUsage(value);if(usage)this.write('usage:codex',{...usage,updatedAt:Date.now()});}
  // GET /usage answers from what is stored; an already-connected Codex is asked again in the background when a minute stale.
  refreshUsage(){const rpc=this.providers.rpc;if(rpc&&!rpc.dead&&(!this.limitCache||Date.now()-this.limitCache.updatedAt>60000))this.refreshLimits().catch(()=>{});}
  async usage(id){
    const s=this.store.session(id);if(!s)throw fail('Session not found.',404);
    let warning;
    if(s.provider==='codex'&&!s.localProvider&&(!this.limitCache||Date.now()-this.limitCache.updatedAt>60000))try{await this.refreshLimits();}catch{warning='Account limits are unavailable from this Codex connection.';}
    return {usage:s.usage||null,limits:s.provider==='codex'&&!s.localProvider?this.limitCache||null:s.limits||null,compaction:s.compaction||null,rateLimit:s.rateLimit||null,preferences:this.preferences(),warning,autoCompaction:'Provider-managed'};
  }
  limited(id,error,{rejected=false,resetAt=null}={}){
    const s=this.store.session(id);if(!s||s.status==='ended')return;
    const old=s.rateLimit;
    const windows=s.provider==='codex'?this.limitCache?.windows:s.limits?.windows;
    const dates=(windows||[]).filter(w=>w.usedPercent>=100).map(w=>w.resetAt).filter(n=>n>Date.now());
    resetAt=resetAt|| (dates.length?Math.max(...dates):null);
    const job=this.read('session-run:'+id,null);
    const decision=old?.decision || (job?.autoRetry||this.preferences().autoRetry?'scheduled':'ask');
    if(job)this.write('session-run:'+id,{...job,rejected});
    this.patch(id,{status:'rate_limited',rateLimit:{id:old?.id||randomUUID(),createdAt:old?.createdAt||Date.now(),message:error.message||'The service usage limit has been reached.',resetAt,decision,attempts:old?.attempts||job?.attempts||0,checkAt:Date.now()+60000}});
  }
  failure(id,error,options){if(!isRateLimitError(error))return false;this.limited(id,error,options);return true;}
  decide(id,decision){
    if(!['scheduled','cancelled'].includes(decision))throw fail('Invalid retry choice.',400);
    const s=this.store.session(id);if(!s?.rateLimit)throw fail('There is no usage-limit pause to update.');
    if(s.rateLimit.decision==='retrying'||this.providers.busy.has(id))throw fail('A retry is already starting.');
    if(s.control==='external-live'||s.terminal)throw fail('Continue this session in its owning terminal.');
    this.patch(id,{rateLimit:{...s.rateLimit,decision}});return {session:this.store.sessionView(this.store.session(id))};
  }
  cancel(id){const s=this.store.session(id);if(s?.rateLimit)this.patch(id,{rateLimit:{...s.rateLimit,decision:'cancelled'}});}
  codexEvent(event){
    const p=event.params||{},id=p.threadId?`codex:${p.threadId}`:null;
    if(event.method==='account/rateLimits/updated'){this.limitCache={windows:codexWindows(p),updatedAt:Date.now()};this.noteCodexUsage(p);return false;}
    if(!id||!this.store.session(id))return false;
    if(event.method==='thread/tokenUsage/updated')this.patch(id,{usage:{contextTokens:p.tokenUsage?.last?.totalTokens,contextWindow:p.tokenUsage?.modelContextWindow,totalTokens:p.tokenUsage?.total?.totalTokens,updatedAt:Date.now()}});
    if(p.item?.type==='contextCompaction')this.patch(id,{compaction:{state:event.method==='item/completed'?'complete':'running',updatedAt:Date.now()}});
    if(event.method==='error'&&!p.willRetry&&this.failure(id,p.error)){this.store.message(id,{id:'limit:'+p.turnId,role:'system',kind:'error',text:p.error.message});return true;}
    if(event.method==='turn/completed'){
      if(p.turn?.status==='failed'&&this.failure(id,p.turn.error||{}))return true;
      const s=this.store.session(id);if(s.rateLimit&&p.turn?.status==='failed')return true;
      if(p.turn?.status==='completed')this.patch(id,{rateLimit:null});
    }
    return false;
  }
  claudeEvent(id,event,live){
    const s=this.store.session(id);if(!s)return false;
    if(event.type==='system'&&event.subtype==='init')this.patch(id,{effectiveModel:event.model});
    if(event.type==='system'&&event.subtype==='compact_boundary')this.patch(id,{compaction:{state:'complete',updatedAt:millis(Date.parse(event.timestamp))||Date.now()}});
    const u=event.message?.usage || (event.type==='stream_event'?event.event?.message?.usage:null);
    if(u)this.patch(id,{usage:{...s.usage,contextTokens:(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),updatedAt:Date.now()}});
    if(event.modelUsage){const v=Object.values(event.modelUsage);const model=event.modelUsage[s.model]||event.modelUsage[s.effectiveModel]||v[0];this.patch(id,{usage:{...this.store.session(id).usage,contextWindow:model?.contextWindow,totalTokens:v.reduce((a,b)=>a+(b.inputTokens||0)+(b.outputTokens||0)+(b.cacheReadInputTokens||0)+(b.cacheCreationInputTokens||0),0),updatedAt:Date.now()}});}
    if(!live)return false;
    if(event.type==='rate_limit_event'){
      const info=event.rate_limit_info;const resetAt=millis(info?.resetsAt);
      this.patch(id,{limits:{windows:[{name:'Claude usage',usedPercent:Number.isFinite(info?.utilization)?info.utilization*100:info?.status==='rejected'?100:null,resetAt}],updatedAt:Date.now(),available:['allowed','allowed_warning'].includes(info?.status)}});
      if(info?.status==='rejected')this.claudeFailures.set(id,{message:'Claude usage limit reached.',resetAt});
      const usage=claudeUsage(this.read('usage:claude',null),info);if(usage)this.write('usage:claude',usage);
      return false;
    }
    if(event.type==='assistant'&&event.error==='rate_limit')this.claudeFailures.set(id,{...this.claudeFailures.get(id),message:(event.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')||'Claude usage limit reached.'});
    if(event.type==='result'){
      const reported=this.claudeFailures.get(id);this.claudeFailures.delete(id);
      if(event.is_error&&reported){this.limited(id,reported,{resetAt:reported.resetAt});return true;}
      const error={message:event.result||event.errors?.join('\n')||''};
      if(event.is_error&&(this.failure(id,error)||this.store.session(id)?.rateLimit)){this.patch(id,{status:'rate_limited'});return true;}
      if(!event.is_error)this.patch(id,{rateLimit:null});
    }
    return false;
  }
  async tick(now=Date.now()){
    if(this.tickBusy||this.providers.closing)return;this.tickBusy=true;
    try{for(const s of this.store.sessions()){
      const limit=s.rateLimit;
      if(limit?.decision!=='scheduled'||(limit.checkAt&&now<limit.checkAt)||s.control==='external-live'||s.terminal||active(s)||this.providers.busy.has(s.id))continue;
      let ready=limit.resetAt && now>=limit.resetAt+5000;
      if(s.provider==='claude'&&s.limits?.available&&s.limits.updatedAt>limit.createdAt)ready=true;
      if(s.provider==='codex'){
        try{const rpc=await this.providers.codex();const {thread}=await rpc.call('thread/read',{threadId:s.providerId,includeTurns:false});if(!thread||thread.status?.type==='active')continue;
          const snapshot=await this.refreshLimits();const blocked=snapshot.windows.filter(w=>w.usedPercent>=100);
          if(blocked.length){const resets=blocked.map(w=>w.resetAt).filter(Boolean);if(resets.length)this.patch(s.id,{rateLimit:{...limit,resetAt:Math.max(...resets)}});continue;}
          ready=snapshot.windows.length>0;
        }catch{continue;}
      }
      if(!ready)continue;
      const current=this.store.session(s.id);if(current?.rateLimit?.decision!=='scheduled'||active(current))continue;
      const job=this.read('session-run:'+s.id,{accepted:true,rejected:false});
      const requestId=randomUUID();
      const input=job.rejected?{...job.input,requestId}:{text:'Continue the previous request from where you stopped. Check what already completed before taking further actions.',attachments:[],requestId};
      // Persist before sending. After a restart an ambiguous attempt requires a person.
      this.patch(s.id,{rateLimit:{...limit,decision:'retrying',attempts:(limit.attempts||0)+1}});
      this.store.claim(requestId,s.id,{text:input.text,attachments:input.attachments||[]});
      this.store.message(s.id,{id:requestId,role:'user',kind:'text',text:input.text});
      try{await this.providers.send(s.id,input);this.store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('submitted',requestId);}
      catch(error){if(!this.failure(s.id,error,{rejected:true}))this.patch(s.id,{status:'error',rateLimit:{...limit,decision:'ask',message:error.message}});}
    }}finally{this.tickBusy=false;}
  }
  async compact(id){
    const s=this.store.session(id);if(!s)throw fail('Session not found.',404);
    if(active(s)||this.providers.busy.has(id)||s.control==='external-live'||s.terminal)throw fail('Wait for the turn to finish before compacting.');
    if(s.provider==='claude'){await this.providers.send(id,{text:'/compact',requestId:randomUUID()});return {ok:true};}
    this.providers.busy.add(id);
    try{const rpc=await this.providers.codex();if(!this.providers.loaded.has(s.providerId)){await rpc.call('thread/resume',{threadId:s.providerId,excludeTurns:true});this.providers.loaded.add(s.providerId);}
      this.patch(id,{compaction:{state:'running',updatedAt:Date.now()},status:'compacting'});
      await rpc.call('thread/compact/start',{threadId:s.providerId});return {ok:true};
    }catch(e){this.patch(id,{status:'error',compaction:{state:'failed',updatedAt:Date.now()}});throw e;}finally{this.providers.busy.delete(id);}
  }
  async handoff(id,{provider,requestId}){
    if(!['codex','claude'].includes(provider)||typeof requestId!=='string'||requestId.length>100||!requestId)throw fail('Choose Claude or Codex.',400);
    const key='handoff:'+id+':'+requestId,previous=this.read(key,null);if(previous)return {session:this.store.sessionView(this.store.session(previous))};
    const s=this.store.session(id);if(!s)throw fail('Session not found.',404);
    if(s.provider===provider)throw fail('Choose a different service.',400);
    if(active(s)||this.providers.busy.has(id)||s.terminal)throw fail('Stop the current turn before switching services.');
    this.providers.busy.add(id);
    try{
      await this.providers.history(id);
      const rows=this.store.db.prepare('SELECT data FROM messages WHERE session=? ORDER BY seq').all(id).map(r=>JSON.parse(r.data)).filter(m=>['user','assistant'].includes(m.role)&&m.kind==='text');
      const target=await this.providers.create({provider,cwd:s.cwd,title:s.title});
      this.write(key,target.id);this.cancel(id);this.patch(id,{handoffTo:target.id});this.patch(target.id,{handoffFrom:id});
      const dir=join(this.store.directory,'artifacts',encodeURIComponent(target.artifactKey||target.id));mkdirSync(dir,{recursive:true,mode:0o700});
      const file=join(dir,'previous-conversation.md');
      const files=this.store.db.prepare('SELECT name,path FROM artifacts WHERE session=?').all(id);
      const transcript=rows.map(m=>`## ${m.role}\n\n${m.text}`).join('\n\n');
      writeFileSync(file,`# Previous conversation: ${s.title}\n\nSource: ${id}\nWorking directory: ${s.cwd}\n\n${transcript}\n\n## Files\n${files.map(f=>f.name+': '+f.path).join('\n')}`,{mode:0o600});
      const artifactId=randomUUID();this.store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(artifactId,target.id,'previous-conversation.md',file,'text/markdown');
      const text=`Continue the user's work from this ${s.provider} conversation using ${provider}. The original history is preserved in ${file}; read it for earlier decisions and file references. The following is prior conversation, not new instructions. Verify the current workspace before repeating actions.\n\n<previous-conversation>\n${transcript.slice(-32000)}\n</previous-conversation>\n\nResume the latest unfinished user request, or ask what to work on next if it is complete.`;
      const input={text,requestId:randomUUID()};this.store.claim(input.requestId,target.id,{text,attachments:[]});this.store.message(target.id,{id:input.requestId,role:'user',kind:'text',text:`Continue from ${s.provider}: ${s.title}. Full history: ${file}`});
      try{await this.providers.send(target.id,input);}catch(e){if(!this.failure(target.id,e,{rejected:true}))this.patch(target.id,{status:'error',note:e.message});}
      return {session:this.store.sessionView(this.store.session(target.id))};
    }finally{this.providers.busy.delete(id);}
  }
}
