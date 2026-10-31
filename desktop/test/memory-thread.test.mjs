import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryThread } from '../src/memory-thread.mjs';

const module = source => 'data:text/javascript,' + encodeURIComponent(source);
const learn = module(`export async function extract(batch){return {facts:batch.messages.filter(m=>m.role==='user').map(m=>({topic:'work/example/analytics',text:'Learned: '+m.text,kind:'fact',sourceMessage:m.id,quote:m.text}))};}
export async function synthesize(){throw new Error('not in this test');}`);
const until = async (check, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out waiting.'); };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentremote-memory-thread-'));
  const store = new Store(dir);
  store.save({ id: 'source', provider: 'claude', status: 'idle', updatedAt: 1 });
  store.message('source', { id: 'user1', role: 'user', kind: 'text', text: 'I use Hex.tech for analytics at Northstar.', completedAt: 1 });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('the memory thread learns on its own connection and reports history loads and warnings to the service', async t => {
  const store = fixture(t); const loaded = [];
  store.knowledge.index(); // the service builds its projection once at its first wiki read
  const thread = new MemoryThread(store, { hooks: learn, intervalMs: 50, idleMs: 0, loadHistory: async id => { loaded.push(id); }, log: () => {} }).start();
  t.after(() => thread.close());
  await until(() => store.memory.list().length);
  assert.equal(store.memory.list()[0].text, 'Learned: I use Hex.tech for analytics at Northstar.');
  assert.deepEqual(loaded, ['source']);
  // The service connection serves the wiki the thread rebuilt without rebuilding it again.
  let rebuilt = 0; const refresh = store.knowledge.refresh.bind(store.knowledge); store.knowledge.refresh = () => { rebuilt++; return refresh(); };
  await until(() => store.knowledge.warning);
  assert.ok(store.knowledge.index().some(a => a.topic.startsWith('work/example')));
  assert.equal(rebuilt, 0);
  await thread.close();
  assert.equal(thread.worker, null);
});

test('a crashed memory thread restarts with backoff and logs it', async t => {
  const store = fixture(t); const logs = [];
  const crash = module(`export async function extract(){process.exit(3);}`);
  const thread = new MemoryThread(store, { hooks: crash, intervalMs: 50, idleMs: 0, restartMs: 20, log: line => logs.push(line) }).start();
  t.after(() => thread.close());
  await until(() => thread.restarts >= 2);
  assert.match(logs[0], /exited \(code 3\); restarting in 20 ms/);
  assert.match(logs[1], /restarting in 40 ms/);
  assert.match(store.memory.warning, /retrying/);
  await thread.close();
});

test('closing the service kills a model CLI the memory thread started', async t => {
  const store = fixture(t);
  const pidFile = join(store.directory, 'cli.pid'); const cli = join(store.directory, 'fake-claude');
  writeFileSync(cli, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`); chmodSync(cli, 0o700);
  const previous = process.env.AGENT_REMOTE_CLAUDE; process.env.AGENT_REMOTE_CLAUDE = cli;
  t.after(() => { if (previous === undefined) delete process.env.AGENT_REMOTE_CLAUDE; else process.env.AGENT_REMOTE_CLAUDE = previous; });
  const thread = new MemoryThread(store, { intervalMs: 50, idleMs: 0, log: () => {} }).start();
  await until(() => existsSync(pidFile) && thread.children.size);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(pid, 0));
  thread.close();
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('a wiki projection rebuilt on another connection is reused until evidence changes', t => {
  const store = fixture(t); const other = new Store(store.directory); t.after(() => other.close());
  assert.deepEqual(store.knowledge.search('Hex'), []); // first read on a connection always builds
  const batch = other.memory.batch('source');
  other.memory.apply(batch, { facts: [{ topic: 'work/example/analytics', text: 'Uses Hex.tech for analytics.', kind: 'fact', sourceMessage: 'user1', quote: 'I use Hex.tech for analytics at Northstar.' }] });
  let rebuilt = 0; const refresh = store.knowledge.refresh.bind(store.knowledge); store.knowledge.refresh = () => { rebuilt++; return refresh(); };
  assert.ok(store.knowledge.search('Hex').length);
  assert.equal(rebuilt, 0);
  other.memory.forget(other.memory.list()[0].id);
  other.db.exec("UPDATE wiki_changes SET version=version+1"); // evidence changed, nobody has rebuilt yet
  assert.deepEqual(store.knowledge.search('Hex'), []);
  assert.equal(rebuilt, 1);
});

test('a wiki refresh with nothing to change does not wait for another connection holding the write lock', t => {
  const store = fixture(t); const other = new Store(store.directory); t.after(() => other.close());
  store.memory.apply(store.memory.batch('source'), { facts: [{ topic: 'work/example/analytics', text: 'Uses Hex.tech for analytics.', kind: 'fact', sourceMessage: 'user1', quote: 'I use Hex.tech for analytics at Northstar.' }] });
  store.db.exec('PRAGMA busy_timeout=50');
  other.db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(store.knowledge.refresh(), false); // read-only: completes while the other connection holds the write lock
    assert.equal(store.memory.apply(store.memory.batch('source'), { facts: [] }), undefined); // nothing new: no write either
  } finally { other.db.exec('ROLLBACK'); }
});
