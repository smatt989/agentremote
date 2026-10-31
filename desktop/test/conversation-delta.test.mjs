import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createServer, conversationReply, artifactDirectory } from '../src/server.mjs';
import { Providers } from '../src/providers.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-delta-')), store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.save({ id: 's', provider: 'claude', control: 'managed', status: 'idle', updatedAt: 0 });
  return store;
}
const get = (store, query = '') => conversationReply(store, 's', new URL('http://x/sessions/s' + query));
const delta = (store, previous) => get(store, `?since=${previous.cursor}&artifacts=${previous.artifactsHash}&images=${previous.imagesHash}`);
const time = m => m.completedAt ?? m.createdAt ?? 0;
// The client's merge (ConversationView): upsert by id, drop removed ids, order by the server's key (time, seq).
function apply(view, reply) {
  if (!reply.delta) return reply.messages;
  const byId = new Map(view.map(m => [m.id, m]));
  for (const id of reply.removed) byId.delete(id);
  for (const m of reply.messages) byId.set(m.id, m);
  const important = new Set(reply.important);
  return [...byId.values()].map(m => ({ ...m, important: important.has(m.id) })).sort((a, b) => time(a) - time(b) || a.seq - b.seq);
}

test('the full page keeps its old shape and adds a cursor and hashes', t => {
  const store = fixture(t);
  store.message('s', { id: 'u', role: 'user', kind: 'text', text: 'hi' });
  const full = get(store);
  for (const key of ['nextBefore', 'session', 'messages', 'artifacts', 'questions']) assert.ok(key in full, key);
  assert.equal(full.delta, undefined);
  assert.equal(full.cursor, store.messageRevision);
  assert.equal(typeof full.artifactsHash, 'string'); assert.equal(typeof full.imagesHash, 'string');
  assert.deepEqual(full.messages.map(m => [m.id, m.important]), [['u', false]]);
});

test('an idle poll returns no rows and omits unchanged artifacts and image placements', t => {
  const store = fixture(t);
  writeFileSync(join(artifactDirectory(store, 's'), 'chart.png'), 'png');
  store.message('s', { id: 'a', role: 'assistant', kind: 'text', text: 'See chart.png' });
  const full = get(store), idle = delta(store, full);
  assert.equal(idle.delta, true);
  assert.deepEqual(idle.messages, []); assert.deepEqual(idle.removed, []);
  assert.equal(idle.artifacts, undefined); assert.equal(idle.images, undefined);
  assert.ok(JSON.stringify(idle).length < 1500, 'idle reply is small');
  // A new file changes the hash, so the list (and placements) come back.
  writeFileSync(join(artifactDirectory(store, 's'), 'more.png'), 'png');
  const next = delta(store, idle);
  assert.equal(next.artifacts.length, 2); assert.notEqual(next.artifactsHash, full.artifactsHash);
});

test('streaming text, completion, acknowledgement renames and deleted streamed copies all reach the client', t => {
  const store = fixture(t);
  store.message('s', { id: 'pending', role: 'user', kind: 'text', text: 'Do it' });
  store.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run('pending', 's', 'f', 'accepted');
  let previous = get(store), view = previous.messages;
  store.append('s', 'msg:1', 'Hel'); store.append('s', 'msg:0', 'Hel');
  let reply = delta(store, previous); view = apply(view, reply); previous = reply;
  assert.deepEqual(view.map(m => m.id), ['pending', 'msg:1', 'msg:0']);
  store.append('s', 'msg:1', 'lo');
  // The provider echoes the user message under its own id (pending → u1), the reply completes,
  // and the duplicate streamed copy at another block index is deleted.
  store.userAcknowledgement('s', { id: 'u1', role: 'user', kind: 'text', text: 'Do it' });
  store.message('s', { id: 'msg:1', role: 'assistant', kind: 'text', text: 'Hello', partial: false });
  new Providers(store).dropStreamedCopies('s', 'msg', 'msg:1', 'Hel');
  reply = delta(store, previous); view = apply(view, reply);
  assert.ok(reply.removed.includes('pending')); assert.ok(reply.removed.includes('msg:0'));
  assert.deepEqual(view.map(m => [m.id, m.text, m.partial]), [['u1', 'Do it', false], ['msg:1', 'Hello', false]]);
  assert.deepEqual(view.map(m => m.id), get(store).messages.map(m => m.id));
});

test('rows that stop presenting (thinking, emptied) are removed, and saved responses are listed every time', t => {
  const store = fixture(t);
  store.message('s', { id: 'a', role: 'assistant', kind: 'text', text: 'Answer', completedAt: 1 });
  const previous = get(store);
  store.message('s', { id: 'th', role: 'assistant', kind: 'thinking', text: 'hmm' });
  store.message('s', { id: 'a', role: 'assistant', kind: 'text', text: '' });
  store.db.prepare('INSERT INTO memory_facts VALUES (?,?,?,?)').run('f1', 's', 'topic', JSON.stringify({ sourceMessage: 'a', important: 1, text: 'x' }));
  const reply = delta(store, previous);
  assert.deepEqual(reply.messages, []); assert.deepEqual(reply.removed.sort(), ['a', 'th']);
  assert.deepEqual(reply.important, ['a']);
});

test('unusable cursors fall back to the full page', t => {
  const store = fixture(t);
  store.message('s', { id: 'a', role: 'user', kind: 'text', text: 'x' });
  for (const since of ['-1', 'abc', String(store.messageRevision + 5)]) assert.equal(get(store, '?since=' + since).delta, undefined, since);
  const start = get(store);
  for (let i = 0; i < 401; i++) store.message('s', { id: 'm' + i, role: 'tool', kind: 'Tool result', text: 'r' + i });
  assert.equal(delta(store, start).delta, undefined, 'too many changes');
  store.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('messageTombstoneFloor', String(store.messageRevision));
  assert.equal(get(store, '?since=' + (store.messageRevision - 1)).delta, undefined, 'older than pruned tombstones');
});

test('tombstones older than a week are pruned on start and raise the floor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-delta-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  store.message('s', { id: 'a', role: 'user', kind: 'text', text: 'x' });
  store.db.prepare('DELETE FROM messages WHERE id=?').run('a');
  store.db.prepare('UPDATE message_tombstones SET at=0').run();
  const rev = store.messageRevision; store.close();
  store = new Store(dir);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM message_tombstones').get().n, 0);
  assert.equal(Number(store.db.prepare("SELECT value FROM settings WHERE key='messageTombstoneFloor'").get().value), rev);
  store.close();
});

test('randomized history: applying deltas always equals a fresh full page', t => {
  const store = fixture(t);
  let seed = 7; const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let previous = get(store), view = previous.messages;
  for (let step = 0; step < 300; step++) {
    const ids = store.db.prepare("SELECT id FROM messages WHERE session='s'").all().map(r => r.id);
    const op = rand(6), id = ids.length ? ids[rand(ids.length)] : null;
    if (op === 0 || !id) store.message('s', { id: 'n' + step, role: ['user', 'assistant', 'tool'][rand(3)], kind: 'text', text: 'text ' + step, completedAt: rand(1000) });
    else if (op === 1) store.append('s', id, ' more');
    else if (op === 2) store.db.prepare('DELETE FROM messages WHERE session=? AND id=?').run('s', id);
    else if (op === 3) store.message('s', { id, role: 'assistant', kind: 'text', text: 'edited ' + step, partial: false });
    else if (op === 4) store.message('s', { id, role: 'assistant', kind: 'thinking', text: 'hidden' });
    else store.db.prepare('UPDATE messages SET id=?,data=json_set(data,\'$.id\',?) WHERE session=? AND id=?').run('r' + step, 'r' + step, 's', id);
    if (rand(3) === 0) {
      const reply = delta(store, previous); assert.equal(reply.delta, true);
      view = apply(view, reply); previous = { ...reply, artifactsHash: reply.artifactsHash, imagesHash: reply.imagesHash };
      const fresh = get(store).messages;
      assert.deepEqual(view.map(m => [m.id, m.text, m.important]), fresh.map(m => [m.id, m.text, m.important]), 'step ' + step);
    }
  }
});

test('over HTTP: old clients get the full page, new ones deltas, and the session list answers unchanged', async t => {
  const store = fixture(t);
  const providers = { send: async () => {}, history: async () => {}, status: () => {}, discover: async () => ({ sessions: store.sessions(), warnings: [] }) };
  const { server } = createServer({ store, providers });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${store.pair(store.pairCode(), 'Phone').token}` };
  store.message('s', { id: 'a', role: 'assistant', kind: 'text', text: 'Hello' });
  const full = await (await fetch(base + '/sessions/s', { headers })).json();
  assert.equal(full.messages.length, 1); assert.equal(full.delta, undefined);
  store.message('s', { id: 'b', role: 'assistant', kind: 'text', text: 'Again' });
  const next = await (await fetch(`${base}/sessions/s?since=${full.cursor}&artifacts=${full.artifactsHash}&images=${full.imagesHash}`, { headers })).json();
  assert.equal(next.delta, true); assert.deepEqual(next.messages.map(m => m.id), ['b']);
  const list = await (await fetch(base + '/sessions', { headers })).json();
  assert.ok(list.sessions.length && list.etag);
  const same = await (await fetch(base + '/sessions?etag=' + list.etag, { headers })).json();
  assert.deepEqual(same, { unchanged: true, etag: list.etag });
  store.save({ ...store.session('s'), title: 'Renamed', updatedAt: 5 });
  const changed = await (await fetch(base + '/sessions?etag=' + list.etag, { headers })).json();
  assert.ok(changed.sessions && changed.etag !== list.etag);
});
