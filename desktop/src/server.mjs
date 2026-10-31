import { ReplyNotifier } from './reply-notifications.mjs';
import { imagePlacements, presentPage } from './inline-images.mjs';
import { presentMessage } from './presentation.mjs';
import { MemoryThread } from './memory-thread.mjs';
import { pendingQuestions, cancelQuestions } from './questions.mjs';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, basename, extname, relative, isAbsolute } from 'node:path';
import { hostname, homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { Providers } from './providers.mjs';
import { DesktopRelay } from './relay-client.mjs';
import { writeDesktopStatus,clearDesktopStatus } from './desktop-status.mjs';
import { refreshTerminal } from './terminal-setup.mjs';
import { RelayState } from './relay-state.mjs';
import { AgentReadiness } from './agents.mjs';
import { autoTitlePatch, renameSession, recentFolders } from './session-meta.mjs';
import { KeepAwake, keepAwakeEnabled, setKeepAwake } from './keep-awake.mjs';
import { MessageQueue, TURN_ACTIVE, queuedMessages, presentedMessage } from './message-queue.mjs';
import { accountUsage } from './session-controls.mjs';

const MIME = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.heic':'image/heic','.pdf':'application/pdf','.svg':'image/svg+xml','.csv':'text/csv','.txt':'text/plain','.md':'text/markdown','.json':'application/json','.html':'text/html','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.aac':'audio/aac','.aif':'audio/aiff','.aiff':'audio/aiff','.caf':'audio/x-caf','.mp4':'video/mp4','.m4v':'video/x-m4v','.mov':'video/quicktime' };
// Agents often save a batch into a subfolder (storyboard/01.png). Register those too, by their relative path,
// within bounds so an accidental large tree cannot flood the phone. Hidden files (.DS_Store) are never listed.
const ARTIFACT_DEPTH = 4, ARTIFACT_LIMIT = 500;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const string = (value, max = 100_000) => { if (typeof value !== 'string' || !value.length || value.length > max) throw error('Invalid or missing text value.'); return value; };
export function artifactDirectory(store,id) { const dir = join(store.directory,'artifacts',encodeURIComponent(store.session(id)?.artifactKey || id)); mkdirSync(dir,{recursive:true,mode:0o700}); return dir; }
export function checkArtifactPath(directory,path) {
  const root = realpathSync(directory); const target = realpathSync(path); const rel = relative(root,target);
  if (rel.startsWith('..') || isAbsolute(rel) || !statSync(target).isFile()) throw error('Artifact is outside its session directory.',403);
  return target;
}
// Bytes per ranged artifact read: base64 in one encrypted relay packet stays well under its 40 MB limit.
export const ARTIFACT_CHUNK=8_000_000;
export function sessionArtifacts(store,id) {
  let count = 0;
  const walk = (directory,prefix,depth) => {
    let entries; try { entries = readdirSync(directory,{withFileTypes:true}); } catch { return; }
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || count >= ARTIFACT_LIMIT) continue;
      const path = join(directory,entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) { if (depth < ARTIFACT_DEPTH) walk(path,name + '/',depth + 1); continue; }
      if (!entry.isFile()) continue;
      count++;
      const mime = MIME[extname(entry.name).toLowerCase()] || 'application/octet-stream';
      const row = store.db.prepare('SELECT id,mime FROM artifacts WHERE path=?').get(path);
      if (!row) store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(randomUUID(),id,name,path,mime);
      else if (row.mime === 'application/octet-stream' && mime !== row.mime) store.db.prepare('UPDATE artifacts SET mime=? WHERE id=?').run(mime,row.id);
    }
  };
  walk(artifactDirectory(store,id),'',0);
  const replies=replyTimes(store,id);
  return store.db.prepare('SELECT id,name,mime,path FROM artifacts WHERE session=?').all(id).filter(a => !a.name.split('/').some(part => part.startsWith('.')))
    .map(({path,...a}) => ({...a,size:fileSize(path),messageId:basename(path)===`${a.id}-${a.name}`?null:artifactMessage(replies,path)}));
}
// Which assistant reply a file belongs to: the first reply (finished, or still streaming) at or after the file was created
// or last modified, with the same 2 s slack inline images use; null while no reply has followed yet, and for uploads.
// Derived only from the file's times and stored rows, so it is stable across polls; memoized per session revision.
const replyMemo=new WeakMap();
function replyTimes(store,id){
  let cache=replyMemo.get(store);if(!cache){cache=new Map();replyMemo.set(store,cache);}
  const key=store.sessionRevision(id),hit=cache.get(id);if(hit?.key===key)return hit.rows;
  const rows=store.db.prepare(`SELECT id,coalesce(json_extract(data,'$.completedAt'),json_extract(data,'$.createdAt'),0) AS time FROM messages WHERE session=? AND json_extract(data,'$.role')='assistant'
    AND json_extract(data,'$.kind')='text' AND length(trim(coalesce(json_extract(data,'$.text'),'')))>0 ORDER BY time,seq`).all(id);
  cache.delete(id);cache.set(id,{key,rows});if(cache.size>32)cache.delete(cache.keys().next().value);
  return rows;
}
// Byte size for the file chips on the phone; null when the file is gone.
const fileSize=path=>{try{return statSync(path).size;}catch{return null;}};
export function artifactMessage(replies,path){
  let stamp;try{const info=statSync(path);stamp=Math.max(info.mtimeMs,info.birthtimeMs||0);}catch{return null;}
  let low=0,high=replies.length;while(low<high){const mid=(low+high)>>1;if(replies[mid].time>=stamp-2000)high=mid;else low=mid+1;}
  return replies[low]?.id??null;
}
// Short content hashes let a polling client say "I already have this" so unchanged lists are not resent.
export const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0,16);
/**
 * GET /sessions/:id. Without `since` this is the original full page (latest 200 messages), plus `cursor`,
 * `artifactsHash` and `imagesHash`, which older apps ignore. With `since=<cursor>` (and optionally `artifacts=` /
 * `images=` hashes) it returns `delta:true` with only the rows changed since the cursor, `removed` ids, the full
 * list of saved-response ids, and the artifact list / image placements only when their hash differs. When the cursor
 * is unusable (too old, from another database, or too many changes) it falls back to the full page.
 */
export function conversationReply(store,id,url,warning) {
  const files=sessionArtifacts(store,id),placements=imagePlacements(store,id,files),important=store.memory.importantIds(id);
  const imageMap=Object.fromEntries([...placements].map(([message,list])=>[message,list]));
  const artifactsHash=contentHash(files),imagesHash=contentHash(imageMap);
  const flag=m=>({...m,important:important.has(m.id)});
  const common={session:store.sessionView(store.session(id)),questions:pendingQuestions(store,id),warning,artifactsHash,imagesHash};
  if(url.searchParams.has('since')){
    const changes=store.messageChanges(id,Number(url.searchParams.get('since')));
    if(changes){
      const shown=presentPage(changes.messages,placements),visible=new Set(shown.map(m=>m.id));
      // Rows that no longer present (thinking, emptied text) are removals from the client's point of view.
      const removed=[...changes.removed,...changes.messages.filter(m=>!visible.has(m.id)).map(m=>m.id)];
      return {delta:true,cursor:changes.cursor,...common,messages:shown.map(flag),removed,important:[...important],
        ...(url.searchParams.get('artifacts')===artifactsHash?{}:{artifacts:files}),...(url.searchParams.get('images')===imagesHash?{}:{images:imageMap})};
    }
  }
  const cursor=store.messageRevision; // before the page query, so a write in between is resent rather than lost
  const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(before) || before<1) throw error('Invalid history cursor.');
  const page=store.messages(id,before);
  return {nextBefore:page.length===200?page[0].seq:null,cursor,...common,messages:presentPage(page,placements).map(flag),artifacts:files};
}
async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw error('Use application/json.',415);
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 28_000_000) throw error('Request exceeds 20 MB attachment limit.',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw error('Invalid JSON.'); }
}
export function createServer({ store = new Store(), providers = new Providers(store), agents = new AgentReadiness({claudeAuth:()=>providers.claudeAuth}), keepAwake, relayState } = {}) {
  const notifications=new ReplyNotifier(store,providers);
  notifications.start();
  const invites={count:0,until:0};
  let discovery; let discoveredAt = 0; let discovering;
  const historyTimes = new Map();
  const attempts = new Map();
  // Starts one turn: persist first; never retry an ambiguous provider submission automatically.
  const submit=(id,body)=>{
    const session=store.session(id);if(!session)return;
    store.save({...session,...autoTitlePatch(store,session,body.text),status:'submitting'});keepAwake?.update();
    new Promise(resolve=>resolve(providers.send(id,body))).then(()=>store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('submitted',body.requestId)).catch(e=>{
      store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('failed-or-unknown',body.requestId);
      if(!providers.controls?.failure(id,e,{rejected:true}))providers.status(id,'error'); store.message(id,{id:`error:${body.requestId}`,role:'system',kind:'error',text:e.message});
    }).catch(()=>{});
  };
  const queue=new MessageQueue({store,providers,submit});
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    const reply = (status,data) => { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
    try {
      // This listener is loopback-only. Remote requests arrive through the encrypted relay.
      // Reject browser-originated requests (including same-origin) to the command API.
      if (req.headers.origin) throw error('Browser requests are not accepted.',403);
      const url = new URL(req.url,'http://localhost');
      if (req.method === 'POST' && url.pathname === '/pair') {
        const address = req.socket.remoteAddress || 'unknown'; const current = attempts.get(address) || { count:0, until:Date.now()+60_000 };
        if (Date.now() > current.until) { current.count=0; current.until=Date.now()+60_000; }
        if (++current.count > 10) throw error('Too many pairing attempts; wait one minute.',429);
        attempts.set(address,current);
        const body = await jsonBody(req);
        return reply(200,{...store.pair(string(body.code,100),string(body.name,100)),name:hostname()});
      }
      const token = req.headers.authorization?.replace(/^Bearer /,'');
      if (!store.authenticate(token)) throw error('Pair this device to connect.',401);
      if(req.method==='POST'&&url.pathname==='/terminal/codex'){
        if(!store.authenticateDesktop(token))throw error('Only the local terminal launcher can request this connection.',403);
        await providers.codex();return reply(200,{endpoint:providers.codexHost.endpoint,token:providers.codexHost.token});
      }
      if(req.method==='GET'&&url.pathname==='/notifications/status')return reply(200,notifications.status());
      if(req.method==='POST'&&url.pathname==='/notifications/device')return reply(200,notifications.register(token,await jsonBody(req)));
      if(req.method==='POST'&&url.pathname==='/terminal/claude'){
        if(!store.authenticateDesktop(token))throw error('Only the desktop launcher can start a terminal.',403);
        return reply(200,await providers.startTerminal(await jsonBody(req)));
      }
      const terminalMatch=url.pathname.match(/^\/sessions\/([^/]+)\/terminal(?:\/(control|input))?$/);
      if(terminalMatch){
        const terminal=providers.terminals?.get(decodeURIComponent(terminalMatch[1]));
        if(!terminal||!store.session(decodeURIComponent(terminalMatch[1])))throw error('This shared terminal is no longer running.',404);
        const owner=store.authenticateDesktop(token)?'desktop':'phone:'+token.slice(-24);
        if(req.method==='GET'&&!terminalMatch[2]){const after=Number(url.searchParams.get('after')||0),wait=Number(url.searchParams.get('wait')||0);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(wait)||wait<0||wait>10000)throw error('Invalid cursor.');const value=await terminal.read(after,{wait});return reply(200,{...value,owner:value.owner===owner?'you':value.owner==='desktop'?'desktop':'phone'});}
        if(req.method==='POST'&&terminalMatch[2]==='control'){return reply(200,{...terminal.control(owner),owner:'you'});}
        if(req.method==='POST'&&terminalMatch[2]==='input'){const body=await jsonBody(req);return reply(200,terminal.input({...body,owner}));}
      }
      if(url.pathname==='/claude/auth'&&req.method==='GET')return reply(200,providers.claudeAuth.summary());
      if(url.pathname==='/claude/auth/login'&&req.method==='POST')return reply(200,await providers.claudeAuth.startLogin());
      if(url.pathname==='/claude/auth/login/code'&&req.method==='POST'){const body=await jsonBody(req);return reply(200,await providers.claudeAuth.submitCode(string(body.id,100),string(body.code,4000)));}
      if(url.pathname==='/claude/auth/login/cancel'&&req.method==='POST'){const body=await jsonBody(req);return reply(200,providers.claudeAuth.cancelLogin(typeof body.id==='string'?body.id:undefined));}
      if(req.method==='GET'&&url.pathname==='/agents')return reply(200,await agents.list());
      if(req.method==='GET'&&url.pathname==='/usage'){providers.controls?.refreshUsage?.();return reply(200,accountUsage(store));}
      if(req.method==='GET'&&url.pathname==='/folders/recent')return reply(200,recentFolders(store));
      if(url.pathname==='/settings/keep-awake'){
        if(req.method==='GET')return reply(200,{enabled:keepAwakeEnabled(store)});
        if(req.method==='POST'){const value=setKeepAwake(store,(await jsonBody(req))?.enabled);keepAwake?.update();return reply(200,value);}
      }
      // Any paired device (or the Mac app) can mint the same one-use, five-minute invite the QR code carries.
      if(req.method==='POST'&&url.pathname==='/pairing/invite'){
        if(Date.now()>invites.until){invites.count=0;invites.until=Date.now()+60_000;}
        if(++invites.count>10)throw error('Too many pairing links; wait one minute.',429);
        relayState||=new RelayState(store);let made;try{made=relayState.invite();}catch(e){throw error(e.message,503);}
        return reply(200,{uri:made.uri,expires:made.invite.expires});
      }
      if (req.method === 'GET' && url.pathname === '/health') return reply(200,{hostId:store.hostId,name:hostname(),home:homedir(),version:'0.1.0'});
      if (url.pathname === '/settings/models') {
        if (req.method === 'GET') return reply(200,store.modelDefaults());
        if (req.method === 'POST') {
          const body = await jsonBody(req); const value = {};
          for (const provider of ['codex','claude','local']) {
            if (typeof body?.[provider] !== 'string' || body[provider].length > 200) throw error('Model names must be text up to 200 characters.');
            value[provider] = body[provider].trim();
          }
          if (!['ollama','lmstudio'].includes(body.localProvider)) throw error('Choose Ollama or LM Studio.');
          value.localProvider = body.localProvider;
          return reply(200,store.setModelDefaults(value));
        }
      }
      if (req.method === 'GET' && url.pathname === '/sessions') {
        if (!discovery || Date.now()-discoveredAt > 5000) {
          discovering ||= providers.discover().then(value => { discovery=value; discoveredAt=Date.now(); return value; }).finally(()=>{ discovering=null; });
          await discovering;
        }
        let claudeAuth;try{claudeAuth=providers.claudeAuth?.summary();}catch{}
        const list={sessions:store.sessions().sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)),warnings:discovery.warnings,claudeAuth};
        // A polling app that already has this exact list gets a few bytes back instead of the whole list again.
        const etag=contentHash(list);
        return reply(200,url.searchParams.get('etag')===etag?{unchanged:true,etag}:{...list,etag});
      }
      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await jsonBody(req);
        string(body.provider,20); if (body.cwd !== undefined) string(body.cwd,4096);
        if (body.model) string(body.model,200); if (body.title) string(body.title,200);
        const session = await providers.create(body); artifactDirectory(store,session.id); discoveredAt=0;
        return reply(201,session);
      }
      if(req.method==='GET' && url.pathname==='/knowledge')return reply(200,{warning:store.knowledge.warning,results:store.knowledge.search(url.searchParams.get('q')||'',{topic:url.searchParams.get('topic')||'',offset:url.searchParams.get('offset')})});
      if(req.method==='GET' && url.pathname==='/knowledge/index')return reply(200,{warning:store.knowledge.warning,results:store.knowledge.index()});
      if(req.method==='GET' && url.pathname==='/knowledge/page')return reply(200,{page:store.knowledge.read(string(url.searchParams.get('id'),200),{offset:url.searchParams.get('offset'),budget:url.searchParams.get('budget')??undefined,revision:url.searchParams.get('revision')??undefined})});
      if(req.method==='GET' && url.pathname==='/knowledge/talk')return reply(200,{talk:store.knowledge.talk(string(url.searchParams.get('id'),200))});
      if(req.method==='POST' && url.pathname==='/knowledge/talk'){const body=await jsonBody(req);let thread;try{thread=store.knowledge.comment(string(body.id,200),string(body.text,1400));}catch(e){throw error(e.message,400);}return reply(200,{ok:true,thread});}
      if (req.method==='GET' && url.pathname==='/memory') return reply(200,{warning:store.memory.warning,topics:store.memory.topics(),results:url.searchParams.get('q')?store.memory.search(url.searchParams.get('q'),{topic:url.searchParams.get('topic')||''}):store.memory.list()});
      if(req.method==='POST' && url.pathname==='/memory/forget'){const body=await jsonBody(req);store.memory.forget(string(body.id,100));return reply(200,{ok:true});}
      if(url.pathname==='/settings/session-preferences') {
        if(req.method==='GET')return reply(200,providers.controls.preferences());
        if(req.method==='POST')return reply(200,providers.controls.setPreferences(await jsonBody(req)));
      }
      const importanceMatch=url.pathname.match(/^\/sessions\/([^/]+)\/importance$/);
      if(req.method==='POST'&&importanceMatch){const body=await jsonBody(req);return reply(200,store.memory.setImportant(decodeURIComponent(importanceMatch[1]),string(body.message,500),body.important));}
      const controlsMatch=url.pathname.match(/^\/sessions\/([^/]+)\/(usage|models|configuration|retry|compact|handoff)$/);
      if(controlsMatch) {
        const id=decodeURIComponent(controlsMatch[1]),action=controlsMatch[2];
        const session=store.session(id);if(!session)throw error('Session not found.',404);
        if(req.method==='GET'&&action==='usage')return reply(200,await providers.controls.usage(id));
        if(req.method==='GET'&&action==='models')return reply(200,await providers.controls.models(session.provider));
        if(req.method==='POST'&&action==='configuration')return reply(200,await providers.controls.configure(id,await jsonBody(req)));
        if(req.method==='POST'&&action==='retry')return reply(200,providers.controls.decide(id,(await jsonBody(req)).decision));
        if(req.method==='POST'&&action==='compact')return reply(200,await providers.controls.compact(id));
        if(req.method==='POST'&&action==='handoff')return reply(200,await providers.controls.handoff(id,await jsonBody(req)));
      }
      const queueMatch=url.pathname.match(/^\/sessions\/([^/]+)\/queue\/cancel$/);
      if(req.method==='POST'&&queueMatch){const id=decodeURIComponent(queueMatch[1]);if(!store.session(id))throw error('Session not found.',404);return reply(200,queue.cancel(id,string((await jsonBody(req))?.id,100)));}
      const answerMatch=url.pathname.match(/^\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/);
      if(req.method==='POST'&&answerMatch){const body=await jsonBody(req);return reply(200,await providers.answer(decodeURIComponent(answerMatch[1]),decodeURIComponent(answerMatch[2]),body.answers));}
      const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(messages|stop|end|delete|artifacts|read|title))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]); const action = match[2];
        if (req.method === 'POST' && action === 'delete' && store.deleted(id)) return reply(200,{ok:true});
        const session = store.session(id); if (!session) throw error('Session not found.',404);
        if(req.method==='POST'&&action==='read'){const body=await jsonBody(req);return reply(200,{session:store.markRead(id,string(body.token,64))});}
        if(req.method==='POST'&&action==='title')return reply(200,renameSession(store,id,(await jsonBody(req))?.title));
        if (req.method === 'POST' && action === 'delete') { await providers.remove(id); historyTimes.delete(id); discoveredAt=0; return reply(200,{ok:true}); }
        if (req.method === 'GET' && !action) {
          let warning;
          if (Date.now()-(historyTimes.get(id)||0)>750) {
            try { await providers.history(id); historyTimes.set(id,Date.now()); } catch (e) { warning=e.message; }
          }
          if (!store.session(id)) throw error('Session not found.',404);
          return reply(200,conversationReply(store,id,url,warning));
        }
        if (req.method === 'POST' && action === 'messages') {
          const body = await jsonBody(req); string(body.requestId,100); string(body.text);
          if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length>10 || body.attachments.some(a=>typeof a!=='string'))) throw error('Invalid attachment list.');
          if (!store.session(id)) throw error('Session not found.',404);
          if(session.control==='terminal')throw error('Open Terminal to type into this shared Claude session.',409);
          if (session.control==='external-live') throw error(session.note,409);
          const content={text:body.text,attachments:body.attachments||[]};
          if(store.db.prepare('SELECT id FROM requests WHERE id=?').get(body.requestId)){store.claim(body.requestId,id,content);return reply(200,{accepted:true,duplicate:true,message:presentedMessage(store,id,body.requestId)});}
          // A follow-up sent while the agent works (or a question waits) is queued and delivered when the turn ends (message-queue.mjs).
          const active=TURN_ACTIVE.includes(session.status);
          // A turn another client drives (a resumable session this service never wrote to) still refuses input.
          if (active && session.control!=='managed' && session.external!==false) throw error('Wait for the current response or interrupt it first.',409);
          if (active || providers.busy?.has(id) || pendingQuestions(store,id).length || queuedMessages(store,id,1).length) {
            if (!store.claim(body.requestId,id,content)) return reply(200,{accepted:true,duplicate:true,message:presentedMessage(store,id,body.requestId)});
            const message=queue.enqueue(id,{requestId:body.requestId,...content});
            const titled=autoTitlePatch(store,store.session(id),body.text);if(Object.keys(titled).length)store.save({...store.session(id),...titled});
            queue.schedule(id,0,{force:store.session(id)?.status==='rate_limited'}); // sending again releases a queue held by a rate-limit pause
            return reply(202,{accepted:true,queued:true,message});
          }
          if (!store.claim(body.requestId,id,content)) return reply(200,{accepted:true,duplicate:true});
          store.message(id,{id:body.requestId,role:'user',kind:'text',text:body.text,...(content.attachments.length?{attachments:content.attachments}:{})});
          submit(id,{...body,attachments:content.attachments});
          return reply(202,{accepted:true,message:presentedMessage(store,id,body.requestId)});
        }
        if (req.method === 'POST' && ['stop','end'].includes(action)) { await providers.stop(id,action==='end'); return reply(200,{ok:true}); }
        if (req.method === 'POST' && action === 'artifacts') {
          const body = await jsonBody(req); const name=basename(string(body.name,200)); const base64=string(body.base64,28_000_000);
          if (!store.session(id)) throw error('Session not found.',404);
          if (providers.busy?.has(id)) throw error('Session operation in progress. Try again shortly.',409);
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw error('Invalid attachment encoding.');
          const bytes = Buffer.from(base64,'base64'); if (bytes.length>20_000_000) throw error('Attachment exceeds 20 MB.',413);
          const artifactId=randomUUID(); const path=join(artifactDirectory(store,id),`${artifactId}-${name}`);
          writeFileSync(path,bytes,{mode:0o600,flag:'wx'});
          const mime=MIME[extname(name).toLowerCase()] || 'application/octet-stream';
          store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(artifactId,id,name,path,mime);
          return reply(201,{id:artifactId,name,mime});
        }
      }
      const artifactMatch=url.pathname.match(/^\/artifacts\/([a-zA-Z0-9-]+)(\/info)?$/);
      if (req.method==='GET' && artifactMatch) {
        const row=store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactMatch[1]); if(!row) throw error('Artifact not found.',404);
        const path=checkArtifactPath(artifactDirectory(store,row.session),row.path);
        const size=statSync(path).size;
        if(artifactMatch[2]) return reply(200,{id:row.id,name:row.name,mime:row.mime,size,chunk:ARTIFACT_CHUNK});
        // Each relay response is one encrypted packet, so large files go to the phone as ?offset=&length= ranges.
        if(url.searchParams.has('offset')){
          const offset=Number(url.searchParams.get('offset')),length=Number(url.searchParams.get('length')||ARTIFACT_CHUNK);
          if(!Number.isSafeInteger(offset) || offset<0 || offset>size || !Number.isSafeInteger(length) || length<1 || length>ARTIFACT_CHUNK) throw error('Invalid byte range.',400);
          const bytes=Buffer.alloc(Math.min(length,size-offset));
          // readSync may return fewer bytes than asked; never send a zero-filled tail as file content.
          const fd=openSync(path,'r');try{for(let read=0,n;read<bytes.length;read+=n){n=readSync(fd,bytes,read,bytes.length-read,offset+read);if(!n)throw error('Artifact changed while reading. Try again.',409);}}finally{closeSync(fd);}
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length}); return res.end(bytes);
        }
        // Whole-file reads have no cap here (the Mac window reads over loopback); the relay still refuses packets too big to carry.
        res.writeHead(200,{'Content-Type':row.mime,'Content-Length':size,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`});
        return pipeline(createReadStream(path),res).catch(()=>res.destroy());
      }
      throw error('Route not found.',404);
    } catch (e) { if (!res.headersSent) reply(e.status || 500,{error:e.message}); else res.destroy(); }
  });
  server.on('close',()=>{notifications.close();queue.close();});
  server.requestTimeout=30_000; server.headersTimeout=10_000;
  return { server,store,providers,notifications,queue };
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const store=new Store(),keepAwake=new KeepAwake(store);
  const {server,providers,notifications}=createServer({store,keepAwake});
  // A restart may interrupt a managed process. Surface the ambiguity without replaying commands.
  for(const session of store.sessions()) if(['running','submitting','waiting'].includes(session.status) && !session.external) providers.status(session.id,'interrupted');
  for(const session of store.sessions())for(const q of pendingQuestions(store,session.id))if(q.native)cancelQuestions(store,session.id);
  // An installed app keeps enabled shell commands current; a development checkout never rewrites them.
  if(import.meta.url.includes('.app/Contents/Resources/'))try{refreshTerminal();}catch(error){console.error('Terminal integration refresh failed: '+error.message);}
  const memoryWorker=new MemoryThread(store,{loadHistory:id=>providers.history(id)});memoryWorker.start();providers.claudeAuth.start();
  const port=Number(process.env.AGENT_REMOTE_PORT || 8787);
  const relay=new DesktopRelay({store,apiURL:`http://127.0.0.1:${port}`});
  let relayStatus='starting';let statusTimer;let listening=false;
  const publishStatus=()=>{if(listening)try{writeDesktopStatus(store,{port,relay:relayStatus});}catch{}};
  notifications.relay=relay;
  relay.on('status',status=>{relayStatus=status;console.log(`Relay: ${status}`);publishStatus();});
  server.listen(port,'127.0.0.1',()=>{listening=true;publishStatus();statusTimer=setInterval(publishStatus,2000);statusTimer.unref();console.log(`Agent Remote listening locally. Run npm run pair to pair a phone.`);relay.start();keepAwake.start();});
  const shutdown=async()=>{keepAwake.close();memoryWorker.close();clearInterval(parentTimer);clearInterval(statusTimer);clearDesktopStatus(store);relay.close();await providers.close();server.close(()=>{store.close();process.exit(0);});};
  const parentPid=Number(process.env.AGENT_REMOTE_PARENT_PID);
  const parentTimer=Number.isInteger(parentPid) && parentPid>1 ? setInterval(()=>{
    try{process.kill(parentPid,0);}catch(error){if(error.code==='ESRCH')shutdown();}
  },2000) : undefined;
  parentTimer?.unref();
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
