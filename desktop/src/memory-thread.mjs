// Background learning (memory extraction, wiki synthesis and the editors) runs in a worker thread with its own
// SQLite connection to the same WAL database, so its synchronous rebuilds and scans never block the service's
// event loop (terminal keystrokes, phone polls). The service keeps the cheap reads and user-initiated writes.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { MemoryWorker, runHooks } from './memory-worker.mjs';

const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch {} };

export class MemoryThread {
  /**
   * store: the service's Store (receives warnings). loadHistory(id) runs on the service thread, where providers live.
   * hooks: optional module URL exporting extract/synthesize overrides (tests and benchmarks; never set in production).
   */
  constructor(store, { loadHistory, intervalMs = 30_000, idleMs = 120_000, hooks, restartMs = 1_000, maxRestartMs = 300_000, stableMs = 600_000, log = message => console.error(message) } = {}) {
    Object.assign(this, { store, loadHistory, intervalMs, idleMs, hooks, restartMs, maxRestartMs, stableMs, log });
    this.delay = restartMs; this.children = new Set(); this.closed = false; this.restarts = 0;
  }
  start() {
    // AGENT_REMOTE_MEMORY_THREAD=0 keeps the previous in-process worker, as a fallback.
    if (process.env.AGENT_REMOTE_MEMORY_THREAD === '0') { this.inline = new MemoryWorker(this.store.memory, { loadHistory: this.loadHistory, intervalMs: this.intervalMs, idleMs: this.idleMs }); this.inline.start(); return this; }
    this.spawn(); return this;
  }
  spawn() {
    if (this.closed) return;
    const worker = new Worker(new URL(import.meta.url), { workerData: { agentRemoteMemoryThread: true, directory: this.store.directory, intervalMs: this.intervalMs, idleMs: this.idleMs, hooks: this.hooks } });
    this.worker = worker; this.spawnedAt = Date.now();
    worker.on('message', message => this.message(worker, message));
    worker.on('error', error => this.log('Memory worker crashed: ' + (error?.stack || error)));
    worker.on('exit', code => {
      // A dead thread cannot reap its model CLI process groups; do it here.
      for (const pid of this.children) killGroup(pid); this.children.clear();
      if (this.worker !== worker) return; this.worker = null;
      if (this.closed) return;
      this.delay = Date.now() - this.spawnedAt >= this.stableMs ? this.restartMs : this.delay;
      const delay = this.delay; this.delay = Math.min(this.maxRestartMs, this.delay * 2); this.restarts++;
      this.store.memory.warning = 'Background learning is retrying. Recent conversations are still searchable.';
      this.log(`Memory worker exited (code ${code}); restarting in ${delay} ms.`);
      this.timer = setTimeout(() => this.spawn(), delay); this.timer.unref?.();
    });
  }
  message(worker, message) {
    if (message?.type === 'ready') { this.ready = true; return; }
    if (message?.type === 'warning') { const target = message.target === 'knowledge' ? this.store.knowledge : this.store.memory; if (target) target.warning = message.value; return; }
    if (message?.type === 'child') { this.children.add(message.pid); return; }
    if (message?.type === 'childExit') { this.children.delete(message.pid); return; }
    if (message?.type === 'loadHistory') {
      Promise.resolve().then(() => this.loadHistory ? this.loadHistory(message.id) : undefined)
        .then(() => ({ type: 'reply', call: message.call, ok: true }), error => ({ type: 'reply', call: message.call, error: String(error?.message || error) }))
        .then(reply => { try { if (this.worker === worker) worker.postMessage(reply); } catch {} });
    }
  }
  /** Stops learning now: kills model CLIs synchronously (as the in-process worker did), then lets the thread close its connection. */
  close() {
    this.closed = true; clearTimeout(this.timer); this.inline?.close();
    for (const pid of this.children) killGroup(pid); this.children.clear();
    const worker = this.worker; if (!worker) return Promise.resolve();
    return new Promise(resolve => {
      const force = setTimeout(() => worker.terminate(), 2_000); force.unref?.();
      worker.once('exit', () => { clearTimeout(force); resolve(); });
      try { worker.postMessage({ type: 'close' }); } catch { worker.terminate(); }
    });
  }
}

async function threadMain({ directory, intervalMs, idleMs, hooks }) {
  const { Store } = await import('./store.mjs');
  const store = new Store(directory);
  // This connection may wait as long as it likes for the service's writes; only the service's own wait must stay short.
  store.db.exec('PRAGMA busy_timeout=30000');
  // Warm this connection's page cache and its one full job-signature pass with a read-only refresh (no write lock
  // unless the wiki really is stale), so the first fact this thread applies does not hold the write lock for long.
  try { store.knowledge.refresh(); } catch {}
  for (const [name, target] of [['memory', store.memory], ['knowledge', store.knowledge]]) {
    // Starts unset, so the first report after a restart also clears the service's "retrying" warning.
    let value;
    Object.defineProperty(target, 'warning', { configurable: true, get: () => value ?? null, set: next => { next ??= null; if (next === value) return; value = next; parentPort.postMessage({ type: 'warning', target: name, value }); } });
  }
  const children = new Set();
  runHooks.spawned = pid => { children.add(pid); parentPort.postMessage({ type: 'child', pid }); };
  runHooks.exited = pid => { children.delete(pid); parentPort.postMessage({ type: 'childExit', pid }); };
  const overrides = hooks ? await import(hooks) : {};
  const calls = new Map(); let next = 0;
  const loadHistory = id => new Promise((resolve, reject) => { const call = ++next; calls.set(call, { resolve, reject }); parentPort.postMessage({ type: 'loadHistory', call, id }); });
  const worker = new MemoryWorker(store.memory, { loadHistory, intervalMs, idleMs, ...(overrides.extract ? { extract: overrides.extract } : {}), ...(overrides.synthesize ? { synthesize: overrides.synthesize } : {}) });
  const tick = worker.tick.bind(worker);
  // Hand finished WAL pages back to the database here, so the service's next commit does not pay for the checkpoint.
  worker.tick = async (...args) => { try { return await tick(...args); } finally { if (!worker.closed) try { store.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {} } };
  parentPort.on('message', message => {
    if (message?.type === 'reply') { const call = calls.get(message.call); calls.delete(message.call); if (message.ok) call?.resolve(); else call?.reject(new Error(message.error)); return; }
    if (message?.type === 'tick') { void worker.tick().catch(() => {}); return; }
    if (message?.type === 'close') void (async () => {
      worker.close(); // aborts the model CLI; wait briefly so this thread reaps it rather than leaving a zombie
      for (const end = Date.now() + 1_000; children.size && Date.now() < end;) await new Promise(r => setTimeout(r, 20));
      try { store.close(); } catch {} process.exit(0);
    })();
  });
  worker.start();
  parentPort.postMessage({ type: 'ready' });
}

if (!isMainThread && workerData?.agentRemoteMemoryThread) await threadMain(workerData);
