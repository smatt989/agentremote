import { SessionControls } from './session-controls.mjs';
import { isTemporarySessionDirectory, isStateNoteSession } from './session-visibility.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { memoryInstructions } from './memory.mjs';
import { createQuestion, questionAnswer, resolveQuestion, cancelQuestions, pendingQuestions } from './questions.mjs';
import { claudeStatus, missingAgent, isMissingCommand } from './presentation.mjs';
import { WebSocketRPC } from './rpc.mjs';
import { ClaudeTerminal, claudeLaunch } from './claude-terminal.mjs';
import { answerTerminalQuestion, answerChoiceDialog, parseDialog, parseChoiceDialog, screenQuestion, matchesDialog } from './terminal-questions.mjs';
import { CodexHost } from './codex-host.mjs';
import { dropQueue } from './message-queue.mjs';
import { ClaudeAuth, AUTH_ERROR } from './claude-auth.mjs';
const exec = promisify(execFile);
const home = homedir();
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
const fullAccess = { approvalPolicy: 'never', sandbox: 'danger-full-access' };
const failure = (text, status = 409) => Object.assign(new Error(text), { status });
// A folder typed on the phone may start with ~; check it the way a new user means it, and say what to do when it is wrong.
export const expandHome = path => typeof path === 'string' && /^~(?=\/|$)/.test(path) ? home + path.slice(1) : path;
const shortPath = path => path === home || path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
export function folderProblem(cwd) {
  let info; try { info = statSync(cwd); } catch (error) { return ['ENOENT','ENOTDIR'].includes(error.code) ? `The folder ${shortPath(cwd)} doesn't exist on this Mac. Check the path, or leave it blank to use your home folder.` : `Agent Remote can't open the folder ${shortPath(cwd)}. Choose another folder, or leave it blank to use your home folder.`; }
  return info.isDirectory() ? null : `${shortPath(cwd)} is a file, not a folder. Enter a folder, or leave it blank to use your home folder.`;
}
// Context recall is best-effort. A long prompt (a service handoff carries up to 32k characters of transcript) must never
// fail the submission because a search validator rejects it; terms() reads only the first 24 distinct words, so truncating loses nothing.
export function recallContext(store, id, text) {
  const query = String(text ?? '').slice(0, 4000); let pages = [], candidates = [];
  try { pages = store.knowledge.search(query, { limit: 3, budget: 1200 }); } catch { pages = []; }
  try { candidates = store.memory.search(query, { excludeSession: id, limit: 5, budget: 4200 - JSON.stringify(pages).length }); } catch { candidates = []; }
  return { pages, candidates };
}
const ephemeralHistoryError = error => /ephemeral threads do not support/i.test(error.message);
export const codexTitle = (old, thread, fallback = 'Codex session') => {
  // A name chosen in Agent Remote (POST /sessions/:id/title) wins over Codex's own thread name.
  if (old?.titleSource === 'custom' && old.title?.trim()) return old.title;
  const meaningful = value => typeof value === 'string' && value.trim() && !/^(?:codex (?:terminal )?session|new session)$/i.test(value.trim());
  return [thread.name, old?.title, thread.preview?.slice(0, 100)].find(meaningful) || fallback;
};
const macToolsPath = fileURLToPath(new URL('./mac-tools.mjs', import.meta.url));

export class Providers {
  constructor(store) { this.store = store; this.controls = new SessionControls(this); this.claudeAuth = new ClaudeAuth(this); this.terminals = new Map(); this.claude = new Map(); this.connecting = null; this.busy = new Set(); this.loaded = new Set(); this.questionRequests = new Map(); this.recalled = new Map(); for(const session of store.sessions())if(session.terminal)store.save({...session,terminal:false,control:'resume',status:'ended',note:'The shared terminal stopped when Agent Remote exited. Resume its history to continue.'}); }
  async startTerminal({command,args,cwd,env,cols=80,rows=28}) {
    if(typeof command!=='string'||!command.startsWith('/')||!Array.isArray(args)||args.some(a=>typeof a!=='string')||typeof cwd!=='string'||!statSync(cwd).isDirectory())throw failure('Invalid terminal launch.',400);
    if(env!==undefined&&(!env||Array.isArray(env)||typeof env!=='object'||Object.values(env).some(v=>typeof v!=='string')))throw failure('Invalid terminal environment.',400);
    const launch=claudeLaunch(args);const id='claude:'+launch.uuid;
    if(this.terminals.has(id)&&!this.terminals.get(id).ended) return {id};
    await this.discoverClaude();
    if(this.terminals.has(id)&&!this.terminals.get(id).ended)return {id};
    // A phone conversation keeps its Claude process between turns; hand an idle one over to Terminal.
    if(this.claude.has(id)){
      if(['running','submitting','waiting'].includes(this.store.session(id)?.status))throw failure('This conversation is still replying in Agent Remote. Wait for the reply to finish, then retry.');
      await this.stop(id);this.claudeActivityAt=0;await this.discoverClaude();
    }
    if(this.claudeActive?.some(a=>[a.sessionId,a.session_id,a.id].includes(launch.uuid))||this.store.session(id)?.control==='external-live'||this.claude.has(id))throw failure('This session is already running outside the shared terminal. Exit it there before resuming.');
    const old=this.store.session(id);
    if(this.store.deleted(id))throw failure('This session was deleted.');
    this.store.save({...old,id,provider:'claude',providerId:launch.uuid,title:old?.title||'Claude terminal session',titleSource:old?.titleSource||(!old?.title?'placeholder':undefined),cwd,status:'idle',external:false,control:'terminal',terminal:true,updatedAt:Date.now(),note:'Same live Claude terminal. Answer its questions here; open Terminal controls for other native prompts.'});
    const tools=this.macTools(id);tools.env.AGENT_REMOTE_TERMINAL='1';
    const instructions=memoryInstructions.replace(/Use ask_question[\s\S]*?Never invent an answer\./,'Use the native AskUserQuestion tool for necessary clarifications. Never invent an answer.');
    const terminal=ClaudeTerminal.create({command,args:['--append-system-prompt',instructions,'--mcp-config',JSON.stringify({mcpServers:{agent_remote_mac:tools}}),...launch.args],cwd,env,cols,rows,onExit:()=>{cancelQuestions(this.store,id);this.status(id,'ended',{terminal:false,control:'resume'});}});
    this.terminals.set(id,terminal);return {id};
  }
  async codex() {
    if (this.rpc && !this.rpc.dead) return this.rpc;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if(this.codexHost && !this.codexHost.exited && !this.codexHost.error){
        const rpc=new WebSocketRPC(this.codexHost.endpoint,this.codexHost.token);
        try{await rpc.initialize();}catch(error){rpc.close();throw error;}
        rpc.on('notification',value=>this.codexEvent(rpc,value));this.loaded.clear();this.rolloutHydrated?.clear();this.rpc=rpc;return rpc;
      }
      await this.codexHost?.close();
      this.shared=false;
      const host=new CodexHost(this.store.directory,process.env.AGENT_REMOTE_CODEX || 'codex');
      this.codexHost=host;const rpc=await host.start().catch(error=>{throw missingAgent('codex',error);});
      rpc.on('notification', value => this.codexEvent(rpc, value));
      this.loaded.clear(); this.rolloutHydrated?.clear(); this.rpc = rpc; return rpc;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  status(id, status, extra = {}) {
    const session = this.store.session(id);
    if (session) this.store.save({ ...session, ...extra, status, updatedAt: Date.now() });
  }
  macTools(id) {
    const key = this.store.session(id)?.artifactKey || id;
    return { command: process.execPath, args: [macToolsPath], env: { AGENT_REMOTE_ARTIFACTS: join(this.store.directory, 'artifacts', encodeURIComponent(key)), AGENT_REMOTE_STATE: this.store.directory, AGENT_REMOTE_SESSION: id } };
  }
  codexItem(id, item, completedAt, partial=false) {
    if (!item?.id) return;
    if(item.type==='contextCompaction')this.recalled.delete(id);
    if (item.type === 'agentMessage') this.store.message(id, { id: item.id, role: 'assistant', kind: 'text', partial, ...(completedAt?{completedAt}:{}), text: item.text || '' });
    else if (item.type === 'userMessage') this.store.userAcknowledgement(id, { id: item.id, role: 'user', kind: 'text', ...(completedAt?{completedAt}:{}), text: visibleText((item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')) });
    else if (!['reasoning'].includes(item.type)) this.store.message(id, { id: item.id, role: 'tool', kind: item.type, text: item.type === 'commandExecution' ? `${item.command || ''}\n${item.aggregatedOutput || ''}` : JSON.stringify(item, null, 2) });
  }
  codexEvent(rpc, event) {
    if(this.controls?.codexEvent(event))return;
    if (this.closing) return;
    const p = event.params || {}; const id = p.threadId && `codex:${p.threadId}`;
    if(event.method==='thread/started' && p.thread && this.codexHost){
      const thread=p.thread;const sid='codex:'+thread.id;const old=this.store.session(sid);
      // Codex can start empty temporary threads during client bootstrap.
      if(thread.ephemeral && !old)return;
      if(isTemporarySessionDirectory(thread.cwd) && old?.external !== false)return;
      this.store.save({...old,id:sid,provider:'codex',providerId:thread.id,title:codexTitle(old,thread,'Codex terminal session'),cwd:thread.cwd||home,status:thread.status?.type==='active'?'running':'idle',external:false,control:'managed',updatedAt:Date.now(),note:'Available in your terminal and Agent Remote.'});
    }
    if (event.method === 'thread/deleted' && id) { this.loaded.delete(p.threadId); this.recalled.delete(id); this.store.deleteSession(id); return; }
    if (id && this.store.session(id)) {
      if (event.method === 'item/agentMessage/delta') this.store.append(id, p.itemId, p.delta);
      else if (event.method === 'item/commandExecution/outputDelta') this.store.append(id, p.itemId, p.delta, 'tool', 'commandExecution');
      else if (event.method === 'item/started' || event.method === 'item/completed') this.codexItem(id, p.item, undefined, event.method==='item/started');
      else if (event.method === 'turn/started') this.status(id, 'running', { turnId: p.turn.id });
      else if (event.method === 'turn/completed' && this.store.session(id).status !== 'ended') this.status(id, p.turn.status === 'failed' ? 'error' : 'idle', { turnId: null });
      else if (event.method === 'error') this.store.message(id, { id: randomUUID(), role: 'system', kind: 'error', text: p.error?.message || 'Codex reported an error.' });
    }
    if (event.id !== undefined && event.method === 'item/tool/requestUserInput' && id && this.store.session(id)) {
      try { const q=createQuestion(this.store,id,p.questions,{native:true});this.questionRequests.set(q.id,{rpc,requestId:event.id,session:id});this.status(id,'waiting');return; } catch {}
    }
    if (event.method === 'serverRequest/resolved') { for(const [qid,r] of this.questionRequests) if(r.requestId===p.requestId && r.session===id){this.questionRequests.delete(qid);const q=pendingQuestions(this.store,id).find(q=>q.id===qid);if(q)resolveQuestion(this.store,q,undefined,'cancelled');} }
    // A terminal may own this interactive request. Leave it available there rather
    // than racing its response with a rejection from the phone adapter.
    if (event.id !== undefined && event.method) {
      if (id) { console.log(`Codex request ${event.method} for ${id} left to its terminal client.`); this.store.message(id, { id: `request:${event.id}`, role: 'system', kind: 'attention', text: 'Codex is waiting for your approval or an answer in Codex on your Mac (in Terminal or your editor). Respond there, or stop this reply and send your message again.' }); }
    }
  }
  async discover() {
    const warnings = [];
    try {
      const rpc = await this.codex();
      const live=new Set((await rpc.call('thread/loaded/list',{})).data);
      let cursor;
      do {
        const page = await rpc.call('thread/list', { limit: 100, cursor, sourceKinds: ['cli','vscode','exec','appServer','unknown'], sortKey: 'updated_at' });
        for (const thread of page.data) {
          if(thread.ephemeral || this.isForeignFixture(thread.cwd))continue;
          const id = `codex:${thread.id}`; const old = this.store.session(id);
          if(isTemporarySessionDirectory(thread.cwd) && old?.external !== false)continue;
          this.store.save({ ...old, id, provider: 'codex', providerId: thread.id, title: codexTitle(old,thread), cwd: thread.cwd || home, status: old?.status === 'ended' ? 'ended' : pendingQuestions(this.store,id).some(q=>q.native)?'waiting':thread.status?.type === 'active' ? 'running' : 'idle', updatedAt: thread.updatedAt * 1000, lastMessageAt:old?.lastMessageAt??thread.updatedAt*1000, external: live.has(thread.id) ? false : old?.external ?? true, control: live.has(thread.id) ? 'managed' : 'resume', note: live.has(thread.id) ? 'Available in your terminal and Agent Remote.' : 'Resume available when the original writer releases the session.' });
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) { if (error.agent !== 'codex' && !isMissingCommand(error)) warnings.push(`Codex conversations couldn't be loaded: ${error.message}`); }
    try { await this.discoverClaude(); } catch (error) { if (!isMissingCommand(error)) warnings.push(`Claude conversations couldn't be loaded: ${error.message}`); }
    return { sessions: this.store.sessions().sort((a,b) => b.updatedAt - a.updatedAt), warnings };
  }
  async claudeActivity() {
    if(this.claudeActivityPending)return this.claudeActivityPending;
    if(Date.now()-(this.claudeActivityAt||0)<1500)return this.claudeActive||[];
    this.claudeActivityPending=(async()=>{const {stdout}=await exec(process.env.AGENT_REMOTE_CLAUDE||'claude',['agents','--json'],{timeout:10000,maxBuffer:4000000});this.claudeActive=JSON.parse(stdout);this.claudeActivityAt=Date.now();return this.claudeActive;})();
    try{return await this.claudeActivityPending;}finally{this.claudeActivityPending=null;}
  }
  async discoverClaude() {
    const active = await this.claudeActivity();
    this.claudeActive = active;
    const root = join(claudeHome, 'projects');
    const files = [];
    if (existsSync(root)) for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const file of readdirSync(join(root, project.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl')) { const path = join(root, project.name, file.name); const stat = statSync(path); files.push({ path, modified: stat.mtimeMs, size: stat.size }); }
      }
    }
    this.transcripts ||= new Map();
    const listed = new Set(files.map(f => f.path)); for (const path of this.transcripts.keys()) if (!listed.has(path)) this.transcripts.delete(path);
    for (const file of files.sort((a,b) => b.modified - a.modified)) {
      const { rows, lastMessageAt } = this.transcript(file);
      const metadata = rows.find(r => r.sessionId && r.cwd);
      if (!metadata || this.isForeignFixture(metadata.cwd)) continue;
      const id = `claude:${metadata.sessionId}`; const old = this.store.session(id);
      if(isStateNoteSession(metadata.cwd,rows)) {
        if(old && !old.internal)this.store.save({...old,internal:true});
        continue;
      }
      if(isTemporarySessionDirectory(metadata.cwd) && old?.external !== false)continue;
      const running = active.find(a => [a.sessionId, a.session_id, a.id].includes(metadata.sessionId));
      const naming = claudeSessionTitle(old,rows);
      const terminal=this.terminals.get(id);const shared=terminal&&!terminal.ended;
      const owned = this.claude.has(id);
      const next = { ...old, id, provider: 'claude', providerId: metadata.sessionId, ...naming, cwd: metadata.cwd, updatedAt: file.modified, lastMessageAt:Math.max(old?.lastMessageAt||0,lastMessageAt), transcript: file.path, external: old?.external ?? true, terminal:!!shared, control: shared ? 'terminal' : owned ? 'managed' : running ? 'external-live' : 'resume', status: owned ? old.status : running ? claudeStatus(running) : old?.status === 'ended' ? 'ended' : 'idle', note: shared ? 'Same live Claude terminal. Answer its questions here; open Terminal controls for other native prompts.' : running && !owned ? 'Open in a desktop Claude client. This view follows its activity, but that client owns input. To type here, exit that Claude session on the Mac and refresh; its history will be resumed.' : 'Local conversation and project settings are retained.' };
      if (JSON.stringify(next) !== JSON.stringify(old)) this.store.save(next);
    }
    this.reconcileClaudeActivity(active);
  }
  // The list refreshes every few seconds; re-reading ~700 transcript tails each time stalled the service.
  // Unchanged files reuse the rows discovery reads: metadata, first prompt, preview and latest titles.
  transcript({ path, modified, size }) {
    const cached = this.transcripts.get(path); if (cached?.modified === modified && cached.size === size) return cached;
    const all = tailJSON(path);
    const preview = r => r.type==='user' && !r.isMeta && !r.isCompactSummary && (t => t && !t.startsWith('<'))(visibleText(textContent(r.message?.content)).replace(/\s+/g,' ').trim());
    const keep = new Set([all.find(r => r.sessionId && r.cwd), all.find(r => r.type==='user'), all.find(preview), ...['custom-title','ai-title','summary'].map(type => all.findLast(r => r.type===type))]);
    const lastMessageAt = all.reduce((max,r) => ['assistant','user'].includes(r.type) && textContent(r.message?.content).trim() ? Math.max(max,Date.parse(r.timestamp)||0) : max, 0);
    const summary = { modified, size, rows: all.filter(r => keep.has(r)), lastMessageAt };
    this.transcripts.set(path, summary); return summary;
  }
  isForeignFixture(cwd) {
    if(!cwd||!existsSync(join(cwd,'.agent-remote-test-fixture')))return false;
    const root=realpathSync(cwd),state=realpathSync(this.store.directory);
    return state!==root&&!state.startsWith(root+'/');
  }
  reconcileClaudeActivity(active) {
    for(const session of this.store.listedSessions()){
      if(session.provider!=='claude'||this.claude.has(session.id)||(this.terminals.get(session.id)&&!this.terminals.get(session.id).ended))continue;
      if(active.some(a=>[a.sessionId,a.session_id,a.id].includes(session.providerId)))continue;
      if(session.control!=='external-live'&&!['running','submitting','waiting'].includes(session.status))continue;
      const missing=session.transcript&&!existsSync(session.transcript);
      this.store.save({...this.store.sessionView(session),control:'resume',terminal:false,status:missing?'ended':'idle',note:missing?'The original client has ended and its transcript was removed. Cached conversation history is retained.':'The original Claude client has exited. You can resume this conversation.'});
    }
  }
  async create({ provider, cwd, model, title = 'New session', localProvider }) {
    cwd = expandHome(typeof cwd === 'string' && cwd.trim() ? cwd.trim() : home);
    const defaults = this.store.modelDefaults();
    model = model?.trim() || defaults[provider] || undefined;
    localProvider ||= defaults.localProvider;
    if (!['codex','claude','local'].includes(provider)) throw failure('Unsupported provider.', 400);
    const folder = folderProblem(cwd); if (folder) throw failure(folder, 400);
    if (provider === 'local' && (!model || !['ollama','lmstudio'].includes(localProvider))) throw failure('Choose a local model and Ollama or LM Studio.', 400);
    if (provider !== 'claude') {
      const rpc = await this.codex();
      const artifactKey = randomUUID();
      const { thread } = await rpc.call('thread/start', { cwd, ...fullAccess, config: {'mcp_servers.agent_remote_mac':this.macTools(artifactKey)}, ...(model ? { model } : {}), ...(provider === 'local' ? { modelProvider: localProvider } : {}) });
      this.loaded.add(thread.id);
      return this.store.save({ id: `codex:${thread.id}`, provider: 'codex', providerId: thread.id, model, title, cwd, external: false, control: 'managed', status: 'idle', updatedAt: Date.now(), localProvider, artifactKey });
    }
    const uuid = randomUUID();
    return this.store.save({ id: `claude:${uuid}`, provider, providerId: uuid, model, title, titleSource:title==='New session'?'placeholder':'custom', cwd, external: false, control: 'managed', status: 'idle', updatedAt: Date.now(), started: false });
  }
  async history(id) {
    const session = this.store.session(id); if (!session) throw failure('Session not found.',404);
    if (session.provider === 'codex') {
      const rpc = await this.codex();
      let thread;
      try {
        if(rpc.ephemeralHistory?.has(session.providerId))throw new Error('ephemeral threads do not support history');
        if(rpc.historyUnavailable)throw new Error('list_turns is not supported yet');
        ({thread}=await rpc.call('thread/read', {threadId:session.providerId,includeTurns:true}));
      } catch (error) {
        const unsupported=/list_turns.*not supported|unsupported.*(?:turn|history)|method not found/i.test(error.message);
        if(!unsupported && !ephemeralHistoryError(error) && !/paginated|includeTurns|hydration/i.test(error.message))throw error;
        let ephemeral = ephemeralHistoryError(error);
        if(unsupported)rpc.historyUnavailable=true;
        ({thread}=await rpc.call('thread/read',{threadId:session.providerId,includeTurns:false}));
        ephemeral ||= thread.ephemeral === true;
        if(!rpc.historyUnavailable && !ephemeral){
          try {const page=await rpc.call('thread/turns/list',{threadId:session.providerId,limit:100,itemsView:'full',sortDirection:'desc'});thread.turns=page.data.reverse();}
          catch(e){if(ephemeralHistoryError(e))ephemeral=true;else {if(!/list_turns.*not supported|unsupported|method not found/i.test(e.message))throw e;rpc.historyUnavailable=true;}}
        }
        if(ephemeral){rpc.ephemeralHistory ||= new Set();rpc.ephemeralHistory.add(session.providerId);}
        if(rpc.historyUnavailable || ephemeral){
          this.rolloutHydrated ||= new Set();
          if(!this.rolloutHydrated.has(id)){
            const existing=this.store.messages(id);const matched=new Set();
            for(const message of codexRolloutMessages(thread.path,session.providerId)){
              if(existing.some(m=>m.id===message.id))continue;
              const same=existing.find(m=>!matched.has(m.id)&&m.role===message.role&&m.text===message.text);
              if(same){matched.add(same.id);continue;}
              this.store.message(id,message);
            }
            this.rolloutHydrated.add(id);
          }
        }
      }
      const current=this.store.session(id);
      if(current)this.store.save({...current,title:codexTitle(current,thread)});
      if(this.store.session(id)?.status!=='ended'&&thread.status){const waiting=pendingQuestions(this.store,id).some(q=>q.native);this.status(id,waiting?'waiting':thread.status.type==='active'?'running':'idle');}
      if(thread.status?.type && thread.status.type!=='notLoaded' && !this.loaded.has(session.providerId)){await rpc.call('thread/resume',{threadId:session.providerId,excludeTurns:true});this.loaded.add(session.providerId);}
      for (const turn of thread.turns || []) for (const item of turn.items || []) {
        const time=value=>typeof value==='number'?(value<1e12?value*1000:value):typeof value==='string'?Date.parse(value)||undefined:undefined;
        const completedAt=time(item.completedAt)??time(item.type==='userMessage'?turn.startedAt:turn.completedAt)??(thread.updatedAt?thread.updatedAt*1000:session.lastMessageAt||session.updatedAt);
        this.codexItem(id,item,completedAt,turn.status==='inProgress'&&item.type==='agentMessage');
      }

    } else if (!this.claude.has(id)) {
      const terminal=this.terminals.get(id);
      if(terminal?.prompts)for(const receipt of terminal.prompts.values()){
        if(this.store.claim(receipt.id,id,{terminalPrompt:receipt.text}))this.store.message(id,{...receipt,requestId:receipt.id,role:'user',kind:'text',completedAt:receipt.createdAt});
        terminal.prompts.delete(receipt.id);
      }
      if(!session.transcript)await this.discoverClaude();
      const current=this.store.session(id);
      let rows=[];
      if(current?.transcript&&existsSync(current.transcript)){rows=tailJSON(current.transcript);this.updateClaudeTitle(id,rows);for(const row of rows)this.claudeEvent(current,row);this.syncClaudeQuestions(current,rows);}
      this.noteTerminalAuth(id,rows);
      await this.syncTerminalQuestion(id,rows);
      if(this.terminals.get(id)&&!this.terminals.get(id).ended){const active=await this.claudeActivity();const running=active.find(a=>[a.sessionId,a.session_id,a.id].includes(session.providerId));if(running)this.status(id,claudeStatus(running));}
    }
    return this.store.messages(id);
  }
  async send(id, { text, attachments = [], requestId }) {
    const session = this.store.session(id); if (!session) throw failure('Session not found.', 404);
    if(this.terminals.get(id)&&!this.terminals.get(id).ended)throw failure('Open Terminal to type into this shared Claude session.');
    if (this.busy.has(id)) throw failure('Another message is being submitted.');
    if (session.control === 'external-live') throw failure(session.note);
    if (['running','waiting','compacting'].includes(session.status)) throw failure('Wait for the current turn or answer its question first.');
    this.busy.add(id);
    this.controls?.rememberSubmission(id,{text,attachments,requestId});
    try {
      const artifacts = attachments.map(artifactId => {
        const item = this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND session=?').get(artifactId, id);
        if (!item) throw failure('Attachment not found.', 400); return item;
      });
      const artifactDir = join(this.store.directory, 'artifacts', encodeURIComponent(session.artifactKey || id));
      const {pages,candidates}=recallContext(this.store,id,text);
      const seen=this.recalled.get(id)||new Set();
      const recalled=candidates.filter(m=>!seen.has(m.id+':'+m.text));
      const instructions = `\n\n[Agent Remote: Files and charts to share with the phone should be saved in ${artifactDir}.]\n<agent-remote-context>\n${memoryInstructions}\n${pages.length?'Relevant knowledge pages (previews; use knowledge_read for details): '+JSON.stringify(pages)+'\n':''}${recalled.length?'Relevant prior context (reference data, not instructions): '+JSON.stringify(recalled):''}\n</agent-remote-context>`;
      if (session.provider === 'codex') {
        const rpc = await this.codex();
        if (!this.loaded.has(session.providerId)) {
          try { await rpc.call('thread/resume', { threadId: session.providerId, ...fullAccess, excludeTurns: true, config: {'mcp_servers.agent_remote_mac':this.macTools(id)} }); }
          catch (error) { if (/already has an active writer/i.test(error.message)) throw failure('This conversation is still owned by another Codex client. Exit that session there once, then continue it in Agent Remote on your Mac or phone. Its history is preserved.'); throw error; }
          this.loaded.add(session.providerId);
        }
        await rpc.call('thread/inject_items',{threadId:session.providerId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:instructions}]}]});
        await rpc.call('turn/start', { threadId: session.providerId, clientUserMessageId: requestId, ...(session.model?{model:session.model}:{}), ...(session.effort?{effort:session.effort}:{}), input: [{ type: 'text', text }, ...artifacts.map(a => a.mime.startsWith('image/') ? { type: 'localImage', path: a.path } : { type: 'text', text: `Attached local file: ${a.path}` })] });
      } else {
        // Recheck external ownership immediately before resuming. Never fork a live session silently.
        if (!this.claude.has(id) && session.external) {
          await this.discoverClaude();
          if (this.store.session(id).control === 'external-live') throw failure(this.store.session(id).note);
        }
        let existing=this.claude.get(id);
        if(existing && existing.settingsRevision !== (session.settingsRevision||0)){
          await this.stopProvider(id);existing=null;
        }
        const child = existing || this.startClaude({...this.store.session(id),...session});
        const content = [{ type: 'text', text: text + instructions }, ...artifacts.map(a => a.mime.startsWith('image/') ? { type: 'image', source: { type: 'base64', media_type: a.mime, data: readFileSync(a.path).toString('base64') } } : { type: 'text', text: `Attached local file: ${a.path}` })];
        await new Promise((resolve,reject) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content }, session_id: session.providerId, parent_tool_use_id: null }) + '\n', error => error ? reject(error) : resolve()));
      }
      this.controls?.accepted(id);
      for(const m of recalled)seen.add(m.id+':'+m.text);
      if(seen.size>200)seen.clear();this.recalled.set(id,seen);
      if(!this.store.session(id)?.rateLimit)this.status(id, 'running', session.provider === 'claude' || !this.shared ? {external:false,control:'managed',note:'Continue this conversation from Agent Remote on your Mac or phone.'} : {});
    } finally { this.busy.delete(id); }
  }
  startClaude(session) {
    const args = ['-p','--verbose','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--dangerously-skip-permissions','--permission-prompt-tool','stdio', session.started || session.external ? '--resume' : '--session-id', session.providerId];
    args.push('--mcp-config',JSON.stringify({mcpServers:{agent_remote_mac:this.macTools(session.id)}}));
    if (session.model) args.push('--model', session.model);
    if (session.effort) args.push('--effort', session.effort);
    args.push('--autocompact','auto');
    const child = spawn(process.env.AGENT_REMOTE_CLAUDE || 'claude', args, { cwd: session.cwd, detached: true, stdio: ['pipe','pipe','pipe'] });
    child.settingsRevision=session.settingsRevision||0;
    this.claude.set(session.id, child);
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => { try { this.claudeEvent(session, JSON.parse(line),true); } catch {} });
    child.on('error', error => { if(this.closing || !this.store.session(session.id))return; console.error(`Claude did not start for ${session.id}: ${error.message}`); this.status(session.id,'error'); this.store.message(session.id,{id:randomUUID(), role:'system',kind:'error',text:(isMissingCommand(error)&&folderProblem(session.cwd))||missingAgent('claude',error).message}); });
    child.on('exit', code => { this.claude.delete(session.id); if(!this.closing){for(const [qid,r] of this.questionRequests)if(r.child===child){this.questionRequests.delete(qid);const q=pendingQuestions(this.store,session.id).find(q=>q.id===qid);if(q)resolveQuestion(this.store,q,undefined,'cancelled');}} if (!this.closing && !['ended','rate_limited'].includes(this.store.session(session.id)?.status)) this.status(session.id,code ? 'error' : 'idle'); });
    this.store.save({ ...session, started: true, control: 'managed' });
    return child;
  }
  updateClaudeTitle(id,rows) {
    const current=this.store.session(id);if(!current)return;
    const naming=claudeSessionTitle(current,rows);
    if(naming.title!==current.title||naming.titleSource!==current.titleSource)this.store.save({...current,...naming});
  }
  claudeEvent(session, event, live=false) {
    if(this.controls?.claudeEvent(session.id,event,live))return;
    if (this.closing) return;
    const id = session.id;
    if (!this.store.session(id) || this.store.deleted(id)) return;
    if(['user','ai-title','custom-title','summary'].includes(event.type))this.updateClaudeTitle(id,[event]);
    if(event.type==='control_request') {this.claudeControl(session,event);return;}
    if(event.type==='control_cancel_request') {for(const [qid,r] of this.questionRequests)if(r.session===id&&r.requestId===event.request_id){this.questionRequests.delete(qid);const q=pendingQuestions(this.store,id).find(q=>q.id===qid);if(q)resolveQuestion(this.store,q,undefined,'cancelled');}return;}
    if(event.type==='system'&&event.subtype==='compact_boundary')this.recalled.delete(id);
    if (event.type === 'stream_event') {
      const e = event.event;
      if (e.type === 'message_start') { session.partialId = e.message.id; session.streamedBlocks = []; }
      if (e.type === 'content_block_start') (session.streamedBlocks ??= []).push({ index: e.index, type: e.content_block?.type, finished: false });
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') this.store.append(id, `${session.partialId}:${e.index}`, e.delta.text);
      return;
    }
    // Claude's resume placeholder is bookkeeping, not an agent answer.
    if(event.type==='assistant' && event.message?.model==='<synthetic>' && textContent(event.message.content).trim()==='No response requested.') {
      this.store.db.prepare('DELETE FROM messages WHERE session=? AND id=?').run(id,`${event.message.id || event.uuid}:0`);
      return;
    }
    if (event.type === 'assistant' || event.type === 'user') {
      const blocks = event.message?.content;
      if (typeof blocks === 'string') { (event.type==='user'?this.store.userAcknowledgement.bind(this.store):this.store.message.bind(this.store))(id,{ id:event.uuid || event.message.id || randomUUID(),role:event.type,kind:'text',...(event.timestamp?{completedAt:Date.parse(event.timestamp)}:{}),text:visibleText(blocks) }); return; }
      for (const [index,block] of (blocks || []).entries()) {
        const blockIndex = this.claudeBlockIndex(session, event, block, index);
        if(['thinking','redacted_thinking'].includes(block.type))continue;
        const itemId = `${event.message.id || event.uuid}:${blockIndex}`;
        const message = { ...(event.timestamp?{completedAt:Date.parse(event.timestamp)}:{}), id: itemId, role: block.type === 'tool_use' || block.type === 'tool_result' ? 'tool' : event.type, kind: block.type, text: block.type === 'text' ? visibleText(block.text) : JSON.stringify(block, null, 2) };
        if (message.role === 'user') this.store.userAcknowledgement(id,message); else this.store.message(id,message);
        if (event.type === 'assistant' && block.type === 'text' && event.message?.id) this.dropStreamedCopies(id, event.message.id, itemId, message.text);
      }
    }
    if (event.type === 'result' && this.store.session(id)?.status !== 'ended') {
      this.status(id, event.is_error ? 'error' : 'idle');
      const text = event.result || event.errors?.join('\n') || 'Claude could not complete the request.';
      if (event.is_error) this.store.message(id, { id:event.uuid || randomUUID(),role:'system',kind:'error',text });
      if (event.is_error && AUTH_ERROR.test(text)) this.claudeAuth.noteFailure(id);
      else if (!event.is_error && this.store.session(id)?.authRequired) this.store.save({ ...this.store.session(id), authRequired: false });
    }
  }
  // Claude Code emits one `assistant` event per finished block. Transcript rows carry the API block index
  // (apiBlockIndex); the live stdout events do not, so the finished block is matched to the streamed copy
  // through the content_block_start events of the same message. Whole-message events fall back to position.
  claudeBlockIndex(session, event, block, index) {
    if (typeof event.apiBlockIndex === 'number') return event.apiBlockIndex + index;
    if (event.message?.id && event.message.id === session.partialId) {
      const streamed = (session.streamedBlocks || []).find(b => !b.finished && b.type === block.type);
      if (streamed) { streamed.finished = true; return streamed.index; }
    }
    return index;
  }
  // A finished reply supersedes any streamed copy of the same text that landed under another block index.
  dropStreamedCopies(id, messageId, keep, text) {
    this.store.db.prepare(`DELETE FROM messages WHERE session=? AND id<>? AND substr(id,1,?)=? AND json_extract(data,'$.partial')=1 AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.kind')='text' AND json_extract(data,'$.text')=?`).run(id, keep, messageId.length+1, messageId+':', text);
  }
  claudeControl(session,event) {
    const child=this.claude.get(session.id);if(!child)return;
    const request=event.request||{};
    if(request.subtype==='can_use_tool' && request.tool_name==='AskUserQuestion') {
      try {const q=createQuestion(this.store,session.id,request.input.questions,{native:true,sourceToolId:request.tool_use_id});this.questionRequests.set(q.id,{child,requestId:event.request_id,session:session.id,input:request.input});this.status(session.id,'waiting');return;}catch{}
    }
    // Preserve the configured full-access mode, but do not auto-answer questions.
    const response=request.subtype==='can_use_tool' && request.tool_name!=='AskUserQuestion'
      ? {behavior:'allow',updatedInput:request.input||{}}
      : {behavior:'deny',message:'Unable to display this question. Ask using agent_remote_mac ask_question.'};
    child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:event.request_id,response}})+'\n');
  }
  syncClaudeQuestions(session,rows) {
    const {answered,asked}=askedQuestions(rows);
    for(const q of pendingQuestions(this.store,session.id))if(q.readOnly&&(answered.has(q.sourceToolId)||session.control!=='external-live'))resolveQuestion(this.store,q,undefined,answered.has(q.sourceToolId)?'answered':'cancelled');
    if(session.control!=='external-live'||pendingQuestions(this.store,session.id).length)return;
    const pending=asked.findLast(b=>!answered.has(b.id));
    if(pending)try{createQuestion(this.store,session.id,pending.input.questions,{native:true,readOnly:true,sourceToolId:pending.id});}catch{}
  }
  // A shared terminal whose login expired records "Login expired · Please run /login" as an
  // authentication_failed API error. Only failures from this terminal process count: an old
  // one in a resumed transcript says nothing about the current login.
  noteTerminalAuth(id,rows) {
    const terminal=this.terminals.get(id);if(!terminal||terminal.ended)return;
    const last=rows.findLast(row=>row.type==='assistant');
    if(!last?.isApiErrorMessage||last.error!=='authentication_failed'||!(Date.parse(last.timestamp)>=terminal.startedAt))return;
    if(terminal.authFailedAt&&this.store.session(id)?.authRequired)return;
    terminal.authFailedAt=Date.now();this.claudeAuth.noteFailure(id);
  }
  // Shared terminals: the dialog on screen is the source of truth for a question card.
  // Claude Code persists the AskUserQuestion tool call at an unpredictable time (often
  // only after the answer), so the transcript merely enriches a card when it matches.
  async syncTerminalQuestion(id,rows) {
    if(this.busy.has(id))return;
    const terminal=this.terminals.get(id);const shared=!!terminal&&!terminal.ended;
    const cards=pendingQuestions(this.store,id).filter(q=>q.terminal);
    if(!shared){for(const q of cards)resolveQuestion(this.store,q,undefined,'cancelled');return;}
    const {answered,asked}=askedQuestions(rows);
    let lines=[];try{lines=await terminal.lines();}catch{}
    let view=null;try{view=parseDialog(lines);}catch{}
    let choice=null;try{choice=view?null:parseChoiceDialog(lines);}catch{}
    this.dialogMissing??=new Map();
    for(const q of cards){
      const done=!!q.sourceToolId&&answered.has(q.sourceToolId);
      const shown=q.choice?choice:view;
      const stale=q.choice?(!!view||(!!choice&&choice.key!==q.dialogKey)):!!view&&(q.review?!view.review:!matchesDialog(view,q.questions.map(item=>({question:item.title}))));
      if(done)resolveQuestion(this.store,q,undefined,'answered');
      else if(stale)resolveQuestion(this.store,q,undefined,'cancelled');
      else if(!shown){const since=this.dialogMissing.get(q.id)||Date.now();this.dialogMissing.set(q.id,since);if(Date.now()-since>4000)resolveQuestion(this.store,q,undefined,'cancelled');}
      if(shown||!pendingQuestions(this.store,id).some(p=>p.id===q.id))this.dialogMissing.delete(q.id);
    }
    if(pendingQuestions(this.store,id).length)return;
    // Folder trust, permission and confirmation prompts become tap-to-answer cards too.
    if(choice){try{createQuestion(this.store,id,[{question:choice.titleText,options:choice.options}],{native:true,terminal:true,screen:true,choice:true,choiceOnly:true,dialogKey:choice.key});}catch{}return;}
    if(!view)return;
    const pending=asked.findLast(b=>!answered.has(b.id));
    const known=!!pending&&this.store.db.prepare('SELECT data FROM questions WHERE session=?').all(id).some(r=>JSON.parse(r.data).sourceToolId===pending.id);
    try{
      if(pending&&!known&&matchesDialog(view,pending.input.questions))createQuestion(this.store,id,pending.input.questions,{native:true,terminal:true,sourceToolId:pending.id});
      else{const shown=screenQuestion(view);if(shown)createQuestion(this.store,id,shown.questions,{native:true,terminal:true,screen:true,...(shown.review?{review:true}:{})});}
    }catch{}
  }
  async stop(id, end = false) {
    if (this.busy.has(id)) throw failure('Session operation in progress. Try again shortly.');
    this.busy.add(id);
    try { await this.stopProvider(id,end); } finally { this.busy.delete(id); }
  }
  async answer(id, questionId, answers) {
    const value=questionAnswer(this.store,id,questionId,answers);if(value.duplicate)return {ok:true,duplicate:true};
    if(this.busy.has(id))throw failure('Session operation in progress. Try again shortly.');
    const {question}=value;const native=this.questionRequests.get(questionId);
    if(question.native) {
      if(question.readOnly)throw failure('This question belongs to the desktop Claude client. Answer it there.');
      if(question.terminal) {
        const terminal=this.terminals.get(id);
        if(!terminal||terminal.ended){resolveQuestion(this.store,question,undefined,'cancelled');throw failure('This shared terminal has ended. Resume the session to continue.');}
        this.busy.add(id);
        try {await (question.choice?answerChoiceDialog:answerTerminalQuestion)(terminal,question,value.answers);}
        catch(e){throw failure(e.message,e.status||409);}
        finally {this.busy.delete(id);}
        if(question.choice){resolveQuestion(this.store,question,value.answers);this.store.message(id,{id:'answer:'+questionId,role:'user',kind:'text',text:value.answers[question.questions[0].id]});return {ok:true};}
        resolveQuestion(this.store,question,value.answers);this.status(id,'running');this.store.message(id,{id:'answer:'+questionId,role:'user',kind:'text',text:value.text});return {ok:true};
      }
      if(native?.child) {
        if(native.child.exitCode!==null||native.child.killed)throw failure('Claude disconnected; interrupt this question to continue.');
        const mapped=Object.fromEntries(question.questions.map(q=>[q.title,value.answers[q.id]]));
        native.child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:native.requestId,response:{behavior:'allow',updatedInput:{...native.input,answers:mapped}}}})+'\n');
        this.questionRequests.delete(questionId);resolveQuestion(this.store,question,value.answers);this.status(id,'running');this.store.message(id,{id:'answer:'+questionId,role:'user',kind:'text',text:value.text});return {ok:true};
      }
      if(!native || native.rpc.dead) {resolveQuestion(this.store,question,undefined,'cancelled');throw failure('This question was interrupted. Send a message to continue.');}
      native.rpc.send({id:native.requestId,result:{answers:Object.fromEntries(Object.entries(value.answers).map(([key,text])=>[key,{answers:[text]}]))}});
      this.questionRequests.delete(questionId);this.status(id,'running');
    } else {
      if(['running','submitting','waiting'].includes(this.store.session(id)?.status))throw failure('The agent is finishing its question. Try again shortly.');
      if(!this.store.claim('answer:'+questionId,id,{text:value.text}))throw failure('Answer submission already attempted; check the conversation before continuing.');
      resolveQuestion(this.store,question,value.answers);
      this.store.message(id,{id:'answer:'+questionId,role:'user',kind:'text',text:value.text});
      try {await this.send(id,{text:value.text,requestId:'answer:'+questionId});}catch(e){this.status(id,'error');this.store.message(id,{id:'error:answer:'+questionId,role:'system',kind:'error',text:e.message});throw e;}
      return {ok:true};
    }
    resolveQuestion(this.store,question,value.answers);this.store.message(id,{id:'answer:'+questionId,role:'user',kind:'text',text:value.text});return {ok:true};
  }
  async stopProvider(id, end = false) {
    this.controls?.cancel(id);
    let session = this.store.session(id); if (!session) throw failure('Session not found.',404);
    const terminal=this.terminals.get(id);
    if(terminal&&!terminal.ended){if(end){await terminal.close();cancelQuestions(this.store,id);this.status(id,'ended',{terminal:false,control:'resume'});}else{terminal.child.stdin.write('\x03');}return;}
    if (session.provider === 'claude' && !this.claude.has(id)) {
      await this.discoverClaude();
      session=this.store.session(id);
      if (this.store.session(id)?.control === 'external-live') throw failure('This live session must be stopped in its original Claude client.');
    }
    if (session.control === 'external-live') throw failure('This live session must be stopped in its original Claude client.');
    if (session.provider === 'codex') {
      const rpc = await this.codex();
      const { thread } = this.loaded.has(session.providerId)
        ? await rpc.call('thread/read',{threadId:session.providerId,includeTurns:false})
        : await rpc.call('thread/resume',{threadId:session.providerId,excludeTurns:true});
      const turnId = thread.turns?.findLast(t => t.status === 'inProgress')?.id || thread.activeTurn?.id || (thread.status?.type === 'active' ? session.turnId : undefined);
      if (turnId) await rpc.call('turn/interrupt',{threadId:session.providerId,turnId});
      else if (thread.status?.type === 'active') throw failure('Active turn ID is unavailable; stop this turn in its original client.');
      if (end) {
        if (turnId) {
          const deadline = Date.now() + 5000;
          while ((await rpc.call('thread/read',{threadId:session.providerId,includeTurns:false})).thread.status?.type === 'active') {
            if (Date.now() > deadline) throw failure('The turn is still stopping. Try again shortly.');
            await new Promise(resolve => setTimeout(resolve,100));
          }
        }
        await rpc.call('thread/backgroundTerminals/clean',{threadId:session.providerId});
        await rpc.call('thread/unsubscribe',{threadId:session.providerId});
        this.loaded.delete(session.providerId);
      }
    } else {
      const child = this.claude.get(id);
      if (child) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        await new Promise((resolve,reject) => {
          const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
          const deadline = setTimeout(() => { cleanup(); reject(failure('Claude has not exited. Try again shortly.')); }, 6000);
          const cleanup = () => { clearTimeout(timer); clearTimeout(deadline); };
          child.once('exit', () => { cleanup(); resolve(); });
          if (child.exitCode !== null || child.signalCode !== null) { cleanup(); resolve(); }
        });
      }
    }
    cancelQuestions(this.store,id);for(const [qid,r] of this.questionRequests)if(r.session===id)this.questionRequests.delete(qid);
    // End drops queued follow-ups; interrupt keeps them, and the queue delivers the next one once this settles.
    if(end)dropQueue(this.store,id);
    this.status(id,end ? 'ended' : 'idle',{turnId:null});
  }
  // The follow-up queue asks before delivering: an interrupted Codex turn can still be winding down.
  async queueReady(id) {
    const session=this.store.session(id);if(session?.provider!=='codex'||!this.rpc||this.rpc.dead)return true;
    try{const {thread}=await this.rpc.call('thread/read',{threadId:session.providerId,includeTurns:false});return thread?.status?.type!=='active';}catch{return true;}
  }
  async remove(id) {
    if (this.busy.has(id)) throw failure('Session operation in progress. Try again shortly.');
    this.busy.add(id);
    try {
      const session = this.store.session(id); if (!session) throw failure('Session not found.',404);
      await this.stopProvider(id,true);
      if (session.provider === 'codex') {
        const rpc = await this.codex();
        await rpc.call('thread/delete',{threadId:session.providerId});
        this.loaded.delete(session.providerId);
      } else {
        removeClaudeHistory(join(claudeHome,'projects'),session.providerId);
      }
      const terminal=this.terminals.get(id);if(terminal){terminal.screen.dispose();terminal.chunks=[];terminal.requests.clear();this.terminals.delete(id);}
      this.recalled.delete(id);this.store.deleteSession(id);
    } finally { this.busy.delete(id); }
  }
  close() { this.closing=true; this.controls?.close(); this.claudeAuth?.close(); this.rpc?.close(); const stopped=this.codexHost?.close(); for (const child of this.claude.values()) try { process.kill(-child.pid, 'SIGTERM'); } catch {} return Promise.all([stopped,...[...this.terminals.values()].map(t=>t.close())]); }
}

export function askedQuestions(rows) {
  const answered=new Set();const asked=[];
  for(const row of rows||[])for(const block of Array.isArray(row.message?.content)?row.message.content:[]) {
    if(block.type==='tool_result')answered.add(block.tool_use_id);
    if(block.type==='tool_use'&&block.name==='AskUserQuestion')asked.push(block);
  }
  return {answered,asked};
}
export function tailJSON(path, maxBytes = 2_000_000) {
  const size = statSync(path).size; const start = Math.max(0,size-maxBytes); const fd = openSync(path,'r');
  const buffer = Buffer.alloc(Math.min(size,maxBytes));
  try { readSync(fd,buffer,0,buffer.length,start); } finally { closeSync(fd); }
  const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
  return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function textContent(value) { return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(b=>b.type==='text').map(b=>b.text).join('\n') : ''; }
export function visibleText(text) { return text.replace(/\n<agent-remote-context>[\s\S]*?<\/agent-remote-context>/g,'').replace(/\n\n\[Agent Remote: Files and charts to share with the phone should be saved in [^\n]*\.\]/g,''); }

export function removeClaudeHistory(root, sessionId) {
  // Only exact session files under Claude's projects directory; never working files.
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw failure('Invalid Claude session ID.');
  const paths = [];
  if (existsSync(root)) for (const project of readdirSync(root,{withFileTypes:true})) {
    if (!project.isDirectory()) continue;
    for (const name of [sessionId + '.jsonl', sessionId]) {
      const path = join(root,project.name,name);
      let info; try { info=lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink() || !realpathSync(path).startsWith(realpathSync(root) + '/')) throw failure('Claude history path is outside its history directory.');
      paths.push(path);
    }
  }
  for (const path of paths) rmSync(path,{recursive:true,force:true});
}

// Compatibility fallback for Codex stores that expose summaries and rollout files
// but reject list_turns. Read only a verified native session file, never a project file.
export function codexRolloutMessages(path,sessionId) {
  if(!path||!existsSync(path))return [];
  const root=process.env.CODEX_HOME||join(home,'.codex');const target=realpathSync(path);
  if(!['sessions','archived_sessions'].some(name=>existsSync(join(root,name))&&target.startsWith(realpathSync(join(root,name))+'/')))return [];
  const fd=openSync(target,'r');const header=Buffer.alloc(65536);let length;try{length=readSync(fd,header,0,header.length,0);}finally{closeSync(fd);}
  let first;try{first=JSON.parse(header.subarray(0,length).toString().split('\n')[0]);}catch{return [];}
  if(first.type!=='session_meta'||first.payload?.id!==sessionId)return [];
  const rows=tailJSON(target);const out=[];
  for(const [index,row] of rows.entries()){
    const p=row.payload||{};
    if(row.type==='response_item'&&p.type==='message'&&['assistant','user'].includes(p.role)){
      const turn=p.internal_chat_message_metadata_passthrough?.turn_id;
      if(p.role==='user'&&!/^[0-9a-f-]{36}$/i.test(turn||''))continue;
      const text=visibleText(Array.isArray(p.content)?p.content.filter(b=>['text','input_text','output_text'].includes(b.type)).map(b=>b.text||'').join('\n'):textContent(p.content));if(!text.trim())continue;
      out.push({id:p.id||'rollout:'+createHash('sha256').update(JSON.stringify([row.timestamp,index,p])).digest('hex'),role:p.role,kind:'text',text,...(Date.parse(row.timestamp)?{completedAt:Date.parse(row.timestamp)}:{})});
    }else if(row.type==='event_msg'&&p.type==='user_message'&&typeof p.message==='string'){
      out.push({id:'rollout-user:'+createHash('sha256').update(JSON.stringify([row.timestamp,index,p])).digest('hex'),role:'user',kind:'text',text:visibleText(p.message),...(Date.parse(row.timestamp)?{completedAt:Date.parse(row.timestamp)}:{})});
    }
  }
  return out;
}

// Native Claude already generates useful titles. Preserve deliberate names and
// prefer its title over a local first-message preview, without another model call.
export function claudeSessionTitle(session,rows) {
 const generic=new Set(['Claude terminal session','Claude session','New session']);
 const clean=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
 const title=clean(session?.title),source=session?.titleSource;
 if(source==='custom'||(!source&&session?.external===false&&title&&!generic.has(title)))return {title:session.title,titleSource:'custom'};
 const custom=clean(rows.findLast(r=>r.type==='custom-title')?.customTitle);
 if(custom)return {title:custom,titleSource:'native-custom'};
 if(source==='native-custom')return {title:session.title,titleSource:source};
 const native=clean(rows.findLast(r=>r.type==='ai-title')?.aiTitle);
 if(native)return {title:native,titleSource:'native-auto'};
 if(source==='native-auto')return {title:session.title,titleSource:source};
 const summary=clean(rows.findLast(r=>r.type==='summary')?.summary);
 const preview=rows.filter(r=>r.type==='user'&&!r.isMeta&&!r.isCompactSummary).map(r=>clean(visibleText(textContent(r.message?.content)))).find(t=>t&&!t.startsWith('<'));
 if(source==='summary'&&!summary)return {title:session.title,titleSource:source};
 if(source==='prompt'&&!summary)return {title:session.title,titleSource:source};
 const text=summary||preview;
 if(text){const short=text.length>100?text.slice(0,97).replace(/\s+\S*$/,'')+'…':text;return {title:short,titleSource:summary?'summary':'prompt'};}
 return {title:title||'Claude session',titleSource:source||'placeholder'};
}
