// Fixture for scripts/test-new-chat.py: a local relay and service (this checkout's code) whose "Mac" is slow to make
// a chat (CREATE_DELAY_MS, default 3000) and fails the first attempt at a chat named "Fail once". A message sent to a
// chat is answered "Echo: <text>". No agent runs. Each request is logged to WORK/requests.jsonl.
// Usage: node new-chat-fixture.mjs WORK
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Store } from '../desktop/src/store.mjs';
import { createServer } from '../desktop/src/server.mjs';
import { RelayState } from '../desktop/src/relay-state.mjs';
import { DesktopRelay } from '../desktop/src/relay-client.mjs';
import { createRelay } from '../relay/src/server.mjs';

const [work] = process.argv.slice(2);
const delay = Number(process.env.CREATE_DELAY_MS || 3000);
const relay = createRelay(); await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
const dir = mkdtempSync(join(tmpdir(), 'ar-new-chat-'));
const store = new Store(dir);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = false;
const providers = {
  discover: async () => ({ sessions: store.sessions(), warnings: [] }),
  history: async () => {},
  status: (id, status) => { const s = store.session(id); if (s) store.save({ ...s, status }); },
  async create({ provider, title = 'New session', cwd = '/tmp', model }) {
    await sleep(delay);
    if (title === 'Fail once' && !failed) { failed = true; throw Object.assign(new Error('The Mac is busy.'), { status: 503 }); }
    const uuid = randomUUID();
    return store.save({ id: `${provider}:${uuid}`, provider, providerId: uuid, model, title, titleSource: title === 'New session' ? 'placeholder' : 'custom', cwd, external: false, control: 'managed', status: 'idle', updatedAt: Date.now(), started: false });
  },
  async send(id, { text }) {
    await sleep(300);
    store.message(id, { id: 'echo-' + randomUUID(), role: 'assistant', kind: 'text', text: 'Echo: ' + text, completedAt: Date.now() });
    providers.status(id, 'idle');
  },
};
const agents = { list: async () => ({ agents: [{ id: 'claude', name: 'Claude', installed: true, signedIn: true }, { id: 'codex', name: 'Codex', installed: true, signedIn: true }] }) };
const { server } = createServer({ store, providers, agents });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const log = join(work, 'requests.jsonl');
const proxy = http.createServer((req, res) => {
  const at = Date.now();
  const upstream = http.request({ host: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers }, up => {
    res.writeHead(up.statusCode, up.headers); up.pipe(res);
    up.on('end', () => appendFileSync(log, JSON.stringify({ at, done: Date.now(), method: req.method, path: req.url, status: up.statusCode }) + '\n'));
  });
  req.pipe(upstream);
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
const state = new RelayState(store); state.configure(`ws://127.0.0.1:${relay.server.address().port}`);
const desktop = new DesktopRelay({ store, state, apiURL: `http://127.0.0.1:${proxy.address().port}` }); desktop.start();
await sleep(1500);
console.log(JSON.stringify({ code: state.invite().uri, delay }));
process.stdin.resume();
process.stdin.on('end', async () => {
  desktop.close(); await relay.close(); server.close(); proxy.close(); store.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
