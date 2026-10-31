// Fixture for scripts/test-conversation-cache.py: a local relay and service (this checkout's code, or an older copy
// passed as SRC) with one large conversation, a byte-counting proxy between the relay client and the service, and
// trigger files the UI test drops into WORK to make the "Mac" add or stream a reply.
// Usage: node conversation-cache-fixture.mjs SRC WORK [STATE_COPY_DIR SESSION_ID]
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
const [src, work, stateCopy, realSession] = process.argv.slice(2);
const { Store } = await import(join(src, 'desktop/src/store.mjs'));
const { createServer, artifactDirectory } = await import(join(src, 'desktop/src/server.mjs'));
const { RelayState } = await import(join(src, 'desktop/src/relay-state.mjs'));
const { DesktopRelay } = await import(join(src, 'desktop/src/relay-client.mjs'));
const { createRelay } = await import(join(src, 'relay/src/server.mjs'));

// RELAY=wss://… registers this throwaway host on that relay (e.g. production, for real internet round trips).
const relay = process.env.RELAY ? null : createRelay(); if (relay) await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
const dir = stateCopy || mkdtempSync(join(tmpdir(), 'ar-cache-'));
if (stateCopy) {
  // A copied state.sqlite holds the live Mac's relay identity and paired devices. Registering that identity on a
  // shared relay takes over the live Mac's route (the relay keeps the newest socket for a host key), so its phones
  // would talk to this copy. Give the copy a new identity and no devices before anything connects.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(stateCopy, 'state.sqlite'));
  db.exec("DELETE FROM settings WHERE key IN ('relayPrivateKey','relayURL','desktopTokenHash','hostId')");
  for (const table of ['devices', 'pairing', 'relay_devices', 'relay_invites', 'relay_received', 'push_devices', 'push_receipts', 'push_question_receipts', 'push_auth_receipts'])
    try { db.exec(`DELETE FROM ${table}`); } catch {}
  const left = db.prepare("SELECT count(*) AS n FROM settings WHERE key='relayPrivateKey'").get().n + db.prepare('SELECT count(*) AS n FROM devices').get().n;
  db.close();
  if (left) throw new Error('Refusing to start: the copied state still has a relay identity or devices.');
}
const store = new Store(dir);
let id = realSession, title;
if (!id) {
  id = 'claude:cache-test'; title = 'Cache test conversation';
  store.save({ id, provider: 'claude', control: 'managed', status: 'idle', title, cwd: '/tmp', updatedAt: Date.now() });
  const start = Date.now() - 600_000, output = 'log line with some tool output\n'.repeat(48);
  for (let i = 0; i < 600; i++) {
    const role = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'tool' : 'assistant';
    store.message(id, { id: 'm' + i, role, kind: role === 'tool' ? 'Tool result' : 'text', text: role === 'tool' ? output : `${role === 'user' ? 'Question' : 'Answer'} ${i}: a paragraph of conversation text that wraps over a couple of lines on a phone.`, completedAt: start + i * 1000 });
  }
  store.message(id, { id: 'final', role: 'assistant', kind: 'text', text: 'Final answer 599', completedAt: start + 601_000 });
  writeFileSync(join(artifactDirectory(store, id), 'chart.png'), 'png');
} else {
  title = store.session(id)?.title || id;
  store.save({ ...store.session(id), status: 'idle' }); // no live agent behind the copy
}
const providers = { discover: async () => ({ sessions: store.sessions(), warnings: [] }), history: async () => {}, status: () => {}, send: async () => {} };
const { server } = createServer({ store, providers });
await new Promise(r => server.listen(0, '127.0.0.1', r));
// Count what the app actually pulls: every relayed request passes through here.
const log = join(work, 'requests.jsonl');
const proxy = http.createServer((req, res) => {
  const started = performance.now();
  const upstream = http.request({ host: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers }, up => {
    let bytes = 0; res.writeHead(up.statusCode, up.headers);
    up.on('data', chunk => { bytes += chunk.length; res.write(chunk); });
    up.on('end', () => { res.end(); appendFileSync(log, JSON.stringify({ at: Date.now(), path: req.url, status: up.statusCode, bytes, ms: +(performance.now() - started).toFixed(1) }) + '\n'); });
  });
  req.pipe(upstream);
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
const state = new RelayState(store); state.configure(process.env.RELAY || `ws://127.0.0.1:${relay.server.address().port}`);
const desktop = new DesktopRelay({ store, state, apiURL: `http://127.0.0.1:${proxy.address().port}` }); desktop.start();
await new Promise(r => setTimeout(r, 1500));
console.log(JSON.stringify({ code: state.invite().uri, session: id, title }));

// Triggers: add-N adds a finished reply; stream-N streams one (with a duplicate streamed copy that is then dropped,
// as Claude's live events can produce); phase-NAME marks a measurement phase in the request log.
const seen = new Set();
const timer = setInterval(async () => {
  for (const name of readdirSync(work)) {
    if (seen.has(name)) continue;
    if (name.startsWith('phase-')) { seen.add(name); appendFileSync(log, JSON.stringify({ at: Date.now(), phase: name.slice(6) }) + '\n'); }
    if (name.startsWith('add-')) { seen.add(name); store.message(id, { id: 'fresh-' + name, role: 'assistant', kind: 'text', text: `Fresh reply ${name.slice(4)}` }); }
    if (name.startsWith('stream-')) {
      seen.add(name); const mid = 'stream-' + name.slice(7);
      for (const part of ['Streaming reply', ' part one', ' part two']) { store.append(id, mid + ':1', part); store.append(id, mid + ':0', part); await new Promise(r => setTimeout(r, 700)); }
      store.message(id, { id: mid + ':1', role: 'assistant', kind: 'text', text: 'Streaming reply complete', partial: false });
      store.db.prepare("DELETE FROM messages WHERE session=? AND id=? AND json_extract(data,'$.partial')=1").run(id, mid + ':0');
    }
  }
}, 200);
process.stdin.resume();
process.stdin.on('end', async () => {
  clearInterval(timer); desktop.close(); await relay?.close(); server.close(); proxy.close(); store.close();
  if (!stateCopy) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
