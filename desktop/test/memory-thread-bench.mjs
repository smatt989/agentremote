// Event-loop benchmark for background learning: same jobs, run on the service thread vs. in the memory thread.
// Usage: sqlite3 ~/Library/Application\ Support/AgentRemote/state.sqlite ".backup /tmp/ar-state.sqlite"
//        node desktop/test/memory-thread-bench.mjs /tmp/ar-state.sqlite [seconds=60]
// Works on fresh copies of the backup in a temp directory; never opens the live database. Model calls are stubbed.
// For a before/after, copy this file into an older checkout's desktop/test and run it there with BENCH_MODES=main.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryWorker } from '../src/memory-worker.mjs';

const [backup, seconds = '60'] = process.argv.slice(2);
if (!backup || /Application Support\/AgentRemote\/state\.sqlite$/.test(backup)) { console.error('Pass a BACKUP copy of state.sqlite, not the live file.'); process.exit(2); }
const latency = Number(process.env.BENCH_MODEL_MS || 300);
// Stub model: extraction quotes real batch messages; synthesis writes valid minimal articles and routing plans, and declines editor jobs.
const hooks = 'data:text/javascript,' + encodeURIComponent(`
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('aborted'));},{once:true});});
let n=0;
export async function extract(batch,topics,{signal}={}){await sleep(${latency},signal);
  return {facts:batch.messages.filter(m=>m.text.trim().length>=8).slice(0,3).map(m=>({topic:'work/bench/topic-'+(n++%6),text:'Bench note: '+m.text.slice(0,80),kind:'fact',sourceMessage:m.id,quote:m.text.slice(0,80)}))};}
export async function synthesize(batch,{signal}={}){await sleep(${latency},signal);
  if(batch.type==='article')return {title:batch.subject.title,summary:'Bench summary.',sections:batch.sources.length?[{heading:'Notes',text:'Bench synthesized text.',evidence:[batch.sources[0].id]}]:[],links:[]};
  if(batch.type==='plan'&&batch.stage==='route')return {subjects:[],assignments:batch.claims.map(c=>({claim:c.id,articles:c.articles.length?c.articles.slice(0,4):[batch.scope+'~1']})),merges:[],corrections:[]};
  throw new Error('Editor job declined by the benchmark stub.');}
`);

const pct = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const count = (db, sql) => db.prepare(sql).get().n;

async function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'agentremote-bench-'));
  copyFileSync(backup, join(dir, 'state.sqlite'));
  const store = new Store(dir);
  store.knowledge.refresh(); // initial projection outside the measurement, in both modes
  store.save({ id: 'bench:writer', provider: 'claude', status: 'running', updatedAt: Date.now() });
  const before = { facts: count(store.db, 'SELECT count(*) n FROM memory_facts'), revisions: count(store.db, 'SELECT count(*) n FROM wiki_revisions'), talk: count(store.db, 'SELECT count(*) n FROM wiki_talk') };
  const options = { intervalMs: 500, loadHistory: async () => {} };
  let worker;
  if (mode === 'main') { const stub = await import(hooks); worker = new MemoryWorker(store.memory, { ...options, extract: stub.extract, synthesize: stub.synthesize }); worker.start(); }
  else { const { MemoryThread } = await import('../src/memory-thread.mjs'); worker = new MemoryThread(store, { ...options, hooks }).start(); }
  // Service-thread load: a 10 ms timer (drift = event-loop stall), a streamed reply write every 50 ms, a wiki poll every second.
  const drift = [], writes = [], reads = []; let last = performance.now(), k = 0;
  const sampler = setInterval(() => { const now = performance.now(); drift.push(now - last - 10); last = now; }, 10);
  const writer = setInterval(() => { const s = performance.now(); store.append('bench:writer', 'bench-' + Math.floor(k++ / 100), 'token '); writes.push(performance.now() - s); }, 50);
  const reader = setInterval(() => { const s = performance.now(); store.knowledge.index(); store.knowledge.search('bench notes'); reads.push(performance.now() - s); }, 1000);
  await new Promise(resolve => setTimeout(resolve, Number(seconds) * 1000));
  clearInterval(sampler); clearInterval(writer); clearInterval(reader);
  await worker.close();
  const after = { facts: count(store.db, 'SELECT count(*) n FROM memory_facts'), revisions: count(store.db, 'SELECT count(*) n FROM wiki_revisions'), talk: count(store.db, 'SELECT count(*) n FROM wiki_talk') };
  store.close(); rmSync(dir, { recursive: true, force: true });
  const f = v => v.toFixed(1).padStart(7);
  console.log(`${mode.padEnd(6)} drift p50${f(pct(drift, .5))} p99${f(pct(drift, .99))} max${f(Math.max(...drift))} ms, >100ms:${String(drift.filter(d => d > 100).length).padStart(4)} | write p99${f(pct(writes, .99))} max${f(Math.max(...writes))} | wiki read p99${f(pct(reads, .99))} max${f(Math.max(...reads))} | +facts ${after.facts - before.facts}, +revisions ${after.revisions - before.revisions}, +talk ${after.talk - before.talk}`);
}

for (const mode of (process.env.BENCH_MODES || 'main,worker').split(',')) await run(mode);
