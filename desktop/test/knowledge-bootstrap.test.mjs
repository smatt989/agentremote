import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Instruction files and the home-folder rules read $HOME; give this file its own.
const home = mkdtempSync(join(tmpdir(), 'agentremote-bootstrap-home-'));
process.env.HOME = home;
const { Store } = await import('../src/store.mjs');
const { MemoryWorker } = await import('../src/memory-worker.mjs');
const { readSetup, writeSetup, projects, nextProject, runProject, importInstructionFiles, applyProfile, profilePage, correctProfile, progress, PROFILE_ID, skimBatch } = await import('../src/knowledge-bootstrap.mjs');
const { parseConversations, importExport, previewExport, removeImport, imports } = await import('../src/chat-import.mjs');
const { createServer } = await import('../src/server.mjs');
test.after(() => rmSync(home, { recursive: true, force: true }));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentremote-bootstrap-test-')); const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
function project(t, name, files = {}) {
  const dir = join(home, name); mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), text); }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const said = (store, session, id, text) => store.message(session, { id, role: 'user', kind: 'text', text, completedAt: 1 });
const quoting = text => ({ topic: 'work/acme', text: 'Acme uses Hex for analytics.', kind: 'fact', sourceMessage: 'u1', quote: text });
const synthesize = async batch => ({ title: batch.topic, summary: batch.sources?.[0]?.text || 'x', sections: (batch.sources || []).map(f => ({ text: f.text, evidence: [f.id] })), links: [] });

test('a new install learns its own chats at once but waits for setup before learning older ones', async t => {
  const store = fixture(t); const dir = project(t, 'acme');
  assert.equal(readSetup(store.db).done, false);
  store.save({ id: 'claude:old', provider: 'claude', cwd: dir, external: true, status: 'idle', updatedAt: 1 });
  store.save({ id: 'claude:new', provider: 'claude', cwd: dir, status: 'idle', updatedAt: 1 });
  said(store, 'claude:old', 'u1', 'I use Hex at Acme.'); said(store, 'claude:new', 'u1', 'I use Hex at Acme.');
  const seen = []; const worker = new MemoryWorker(store.memory, { synthesize, extract: async batch => { if (batch.messages) seen.push(batch.session); return { facts: [] }; }, idleMs: 0 });
  t.after(() => worker.close());
  for (let i = 0; i < 4; i++) await worker.tick(1000 + i);
  assert.deepEqual([...new Set(seen)], ['claude:new']);
  assert.equal(progress(store.memory).waiting, 1);
  writeSetup(store.memory, { done: true });
  for (let i = 0; i < 6; i++) await worker.tick(2000 + i);
  assert.ok(seen.includes('claude:old'));
});

test('an install that already learned something is treated as set up', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentremote-bootstrap-existing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(dir); store.db.prepare("DELETE FROM settings WHERE key='knowledge-setup'").run();
  store.db.prepare('INSERT INTO memory_facts VALUES(?,?,?,?)').run('f', 's', 'work/acme', JSON.stringify({ id: 'f', topic: 'work/acme', text: 'x', kind: 'fact', createdAt: 1 })); store.close();
  store = new Store(dir); assert.equal(readSetup(store.db).done, true); store.close();
});

test('excluding a project forgets what was learned there and hides its messages from retrieval', t => {
  const store = fixture(t); const secret = project(t, 'secret'), open = project(t, 'open');
  writeSetup(store.memory, { done: true });
  store.save({ id: 'claude:s', provider: 'claude', cwd: join(secret, 'sub'), status: 'idle', updatedAt: 1 });
  store.save({ id: 'claude:o', provider: 'claude', cwd: open, status: 'idle', updatedAt: 1 });
  said(store, 'claude:s', 'u1', 'I use Hex at Acme.'); said(store, 'claude:o', 'u1', 'Our Hex workspace is shared.');
  store.memory.apply(store.memory.batch('claude:s'), { facts: [quoting('I use Hex at Acme.')] });
  assert.ok(store.memory.search('Hex').some(r => r.sourceSession === 'claude:s'));
  writeSetup(store.memory, { excluded: [secret] });
  assert.equal(store.memory.search('Hex').some(r => r.sourceSession === 'claude:s'), false);
  assert.ok(store.memory.search('Hex').some(r => r.sourceSession === 'claude:o'));
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_facts WHERE session='claude:s'").get().n, 0);
  assert.equal(projects(store).find(p => p.path === join(secret, 'sub')).excluded, true, 'a folder below an excluded one is excluded');
  // Excluding the home folder covers chats run in ~ itself, not every project below it.
  writeSetup(store.memory, { excluded: [home] });
  assert.equal(projects(store).find(p => p.path === open).excluded, false);
});

test('an old session loads its history even while newer chats keep producing work', async t => {
  const store = fixture(t); writeSetup(store.memory, { done: true });
  store.save({ id: 'claude:busy', provider: 'claude', status: 'idle', updatedAt: 10 });
  store.save({ id: 'claude:old', provider: 'claude', status: 'idle', updatedAt: 1 });
  store.db.prepare('INSERT INTO memory_history VALUES(?,?)').run('claude:busy', 10);
  let n = 0; const loaded = [];
  const worker = new MemoryWorker(store.memory, { synthesize, idleMs: 0, loadHistory: async id => loaded.push(id), extract: async () => ({ facts: [] }) });
  t.after(() => worker.close());
  said(store, 'claude:busy', 'm' + n++, 'More work on the busy chat.');
  await worker.tick(100);
  assert.deepEqual(loaded, ['claude:old']);
});

test('the project pass cites project files, replaces its earlier notes and rejects invented quotes', async t => {
  const store = fixture(t); writeSetup(store.memory, { done: true, instructions: false });
  const dir = project(t, 'widget', { 'README.md': '# Widget\nWidget syncs invoices to the ledger every night.', 'package.json': '{"name":"widget","scripts":{"test":"node --test"}}' });
  store.save({ id: 'claude:w', provider: 'claude', cwd: dir, status: 'idle', updatedAt: 1, title: 'Fix ledger sync' });
  said(store, 'claude:w', 'u1', 'The nightly sync is failing again');
  const job = await nextProject(store.memory);
  assert.equal(job.project.path, dir);
  assert.match(job.sources.find(s => s.id === 'sessions').text, /Fix ledger sync: The nightly sync is failing again/);
  let payload;
  const extract = async (_b, _t, options) => { payload = options.payload; return { facts: [
    { topic: 'work/widget', text: 'Widget syncs invoices to the ledger nightly.', kind: 'fact', source: 'readme', quote: 'Widget syncs invoices to the ledger every night.' },
    { topic: 'work/widget', text: 'Widget is written in Rust.', kind: 'fact', source: 'readme', quote: 'Widget is written in Rust.' }] }; };
  assert.equal(await runProject(store.memory, job, extract), 1);
  assert.equal(payload.project.name, 'widget');
  const facts = store.db.prepare("SELECT data FROM memory_facts WHERE session LIKE 'project:%'").all().map(r => JSON.parse(r.data));
  assert.equal(facts.length, 1); assert.match(facts[0].trust, /Project file ~\/widget\/README\.md/);
  assert.equal(await nextProject(store.memory), null, 'a fresh overview is not redone');
  assert.ok(store.knowledge.search('invoices ledger').length);
});

test('instruction files import with their @imports, never through symlinks or outside the project', t => {
  const store = fixture(t); writeSetup(store.memory, { done: true });
  const outside = project(t, 'elsewhere', { 'private.md': 'Do not import me.' });
  const dir = project(t, 'tools', { 'CLAUDE.md': 'Team notes.\n@docs/conventions.md\n@../elsewhere/private.md', 'docs/conventions.md': 'Releases go out on Thursdays.' });
  symlinkSync(join(outside, 'private.md'), join(dir, 'AGENTS.md'));
  store.save({ id: 'claude:t', provider: 'claude', cwd: dir, status: 'idle', updatedAt: 1 });
  assert.ok(importInstructionFiles(store.memory) >= 2);
  const texts = store.db.prepare("SELECT data FROM memory_facts WHERE json_extract(data,'$.sourceMessage') LIKE 'instructions:%'").all().map(r => JSON.parse(r.data).text).join('\n');
  assert.match(texts, /Releases go out on Thursdays/); assert.doesNotMatch(texts, /Do not import me/);
  assert.equal(importInstructionFiles(store.memory), 0, 'unchanged files are not re-imported');
  unlinkSync(join(dir, 'docs/conventions.md'));
  importInstructionFiles(store.memory);
  assert.doesNotMatch(store.db.prepare("SELECT group_concat(data) t FROM memory_facts").get().t || '', /Thursdays/);
  writeSetup(store.memory, { excluded: [dir] });
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_facts WHERE json_extract(data,'$.sourceMessage') LIKE 'instructions:%'").get().n, 0);
});

const chatgpt = [{ conversation_id: 'c1', title: 'Trip planning', create_time: 1700000000, update_time: 1700000100, current_node: 'd', mapping: {
  root: { id: 'root', parent: null, message: null },
  a: { id: 'a', parent: 'root', message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['I prefer aisle seats.'] }, create_time: 1700000001 } },
  b: { id: 'b', parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['A discarded answer.'] } } },
  c: { id: 'c', parent: 'a', message: { id: 'c', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Noted: aisle seats.'] } } },
  d: { id: 'd', parent: 'c', message: { id: 'd', author: { role: 'system' }, content: { content_type: 'text', parts: ['hidden'] } } } } },
  { conversation_id: 'c2', title: 'Empty', mapping: {}, current_node: null }];
const claude = [{ uuid: 'k1', name: 'Recipes', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', chat_messages: [
  { uuid: 'm1', sender: 'human', text: '', content: [{ type: 'text', text: 'I am vegetarian.' }], created_at: '2026-01-02T00:00:00Z' },
  { uuid: 'm2', sender: 'assistant', text: 'Got it.', created_at: '2026-01-02T00:00:01Z' }] }];

test('chat exports keep only the shown branch and the user/assistant text', () => {
  const parsed = parseConversations(chatgpt);
  assert.equal(parsed.source, 'chatgpt'); assert.equal(parsed.conversations.length, 1);
  assert.deepEqual(parsed.conversations[0].messages.map(m => m.text), ['I prefer aisle seats.', 'Noted: aisle seats.']);
  const other = parseConversations(claude);
  assert.equal(other.source, 'claude.ai'); assert.deepEqual(other.conversations[0].messages.map(m => m.role), ['user', 'assistant']);
  assert.throws(() => parseConversations([{ hello: 1 }]), /not a ChatGPT or Claude.ai/);
});

test('imported chats are hidden from the session list, learned after setup, and removable', async t => {
  const store = fixture(t); const dir = mkdtempSync(join(tmpdir(), 'agentremote-export-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'conversations.json'), JSON.stringify(chatgpt));
  execFileSync('/usr/bin/zip', ['-q', '-j', join(dir, 'export.zip'), join(dir, 'conversations.json')]);
  const preview = await previewExport(join(dir, 'export.zip'));
  assert.equal(preview.usable, 1); assert.equal(preview.options.at(-1).calls, 1);
  const result = await importExport(store, join(dir, 'export.zip'), 50);
  assert.equal(result.conversations, 1);
  assert.equal(store.sessions().length, 0, 'imports never appear as chats');
  assert.ok(store.memory.search('aisle seats').length, 'imported text is searchable at once');
  const providers = [];
  const worker = new MemoryWorker(store.memory, { synthesize, idleMs: 0, extract: async (batch, _t, o) => { providers.push(o.provider); return { facts: [{ topic: 'personal/travel', text: 'Prefers aisle seats.', kind: 'fact', sourceMessage: 'a', quote: 'I prefer aisle seats.' }] }; } });
  t.after(() => worker.close());
  await worker.tick(1); assert.equal(providers.length, 0, 'imports wait for setup');
  writeSetup(store.memory, { done: true, instructions: false });
  for (let i = 0; i < 3; i++) await worker.tick(10 + i);
  assert.deepEqual(providers, ['claude']);
  assert.equal(imports(store)[0].learned, 1);
  removeImport(store, result.id);
  assert.equal(store.memory.search('aisle').length, 0); assert.equal(imports(store).length, 0);
});

test('About you validates its links, renders as a wiki page and turns fixes into user statements', t => {
  const store = fixture(t); writeSetup(store.memory, { done: true });
  store.save({ id: 's', provider: 'claude', status: 'idle', updatedAt: 1 });
  said(store, 's', 'u1', 'I use Hex at Acme.');
  store.memory.apply(store.memory.batch('s'), { facts: [quoting('I use Hex at Acme.')] });
  const article = store.knowledge.index()[0].id, fact = store.db.prepare('SELECT id FROM memory_facts').get().id;
  const profile = applyProfile(store.memory, { summary: 'You build analytics at Acme.', sections: [
    { heading: 'How you work', items: [{ text: 'You use Hex for analytics.', articles: [article], evidence: ['u1'] }, { text: 'You invented this.', articles: ['nope~1'], evidence: [] }] }] }, new Map([['u1', fact]]));
  assert.equal(profile.sections[0].items.length, 1);
  const page = profilePage(store);
  assert.match(page.markdown, /## How you work\n\n- You use Hex for analytics\. \(\[/); assert.equal(page.id, PROFILE_ID);
  const item = profile.sections[0].items[0];
  correctProfile(store, { item: item.id, text: 'I use Hex and dbt.' });
  assert.ok(store.db.prepare("SELECT 1 FROM memory_facts WHERE json_extract(data,'$.trust')='User stated' AND json_extract(data,'$.text') LIKE 'Correction to %dbt.'").get());
  const fixed = profilePage(store).profile.sections[0].items[0];
  assert.equal(fixed.text, 'I use Hex and dbt.');
  correctProfile(store, { item: fixed.id, wrong: true });
  assert.equal(profilePage(store).profile.sections.length, 0);
  assert.throws(() => correctProfile(store, { item: 'gone', text: 'x' }), /changed/);
});

test('the wiki routes pin About you first and keep setup routes to the Mac app', async t => {
  const store = fixture(t); writeSetup(store.memory, { done: true });
  const token = store.createDevice('Phone').token, desktop = store.desktopToken();
  const { server, notifications } = createServer({ store, providers: { claudeAuth: { summary: () => ({ state: 'ok' }) }, discover: async () => ({ sessions: [], warnings: [] }), history: async () => {}, send: async () => {} } });
  t.after(async () => { notifications.close(); await new Promise(r => server.close(r)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (path, options = {}, auth = token) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...options, headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json', ...(options.headers || {}) } });
  const index = await (await call('/knowledge/index')).json();
  assert.equal(index.results[0].id, PROFILE_ID);
  assert.equal((await (await call('/knowledge/page?id=' + PROFILE_ID)).json()).page.title, 'About you');
  assert.equal((await call('/knowledge/sources')).status, 403);
  assert.equal((await call('/knowledge/sources', {}, desktop)).status, 200);
  assert.equal((await call('/knowledge/talk', { method: 'POST', body: JSON.stringify({ id: PROFILE_ID, text: 'I moved to Berlin in 2026.' }) })).status, 200);
  assert.equal((await (await call('/knowledge/talk?id=' + PROFILE_ID)).json()).talk.threads.length, 1);
});

test('the first pass keeps the user\'s words, samples replies and tool output, and leaves full learning untouched', async t => {
  const store = fixture(t); writeSetup(store.memory, { done: true, instructions: false });
  store.save({ id: 'claude:long', provider: 'claude', status: 'idle', updatedAt: 1 });
  store.message('claude:long', { id: 'u0', role: 'user', kind: 'text', text: '<agent-remote-context>old wiki text</agent-remote-context>\nI always deploy on Fridays.', completedAt: 1 });
  store.message('claude:long', { id: 'tool', role: 'tool', kind: 'commandExecution', text: 'SELECT count(*) FROM clogs -> 51 users ' + 'x'.repeat(50_000) });
  store.message('claude:long', { id: 'ask', role: 'tool', kind: 'mcpToolCall', text: JSON.stringify({ id: 'k1', name: 'mcp__agent_remote_mac__knowledge_search', input: { query: 'x' } }) });
  store.message('claude:long', { id: 'recall', role: 'tool', kind: 'mcpToolCall', text: JSON.stringify({ tool_use_id: 'k1', content: 'Old wiki article text' }) });
  for (let i = 1; i < 80; i++) { said(store, 'claude:long', 'u' + i, 'Request ' + i + ' ' + 'y'.repeat(300)); store.message('claude:long', { id: 'a' + i, role: 'assistant', kind: 'text', text: 'Reply ' + 'z'.repeat(2000) }); }
  const batch = skimBatch(store.memory, 'claude:long');
  assert.ok(batch.messages.reduce((n, m) => n + m.text.length, 0) <= 24_000);
  assert.equal(batch.messages[0].text, 'I always deploy on Fridays.');
  const tool = batch.messages.find(m => m.id === 'tool');
  assert.ok(tool && tool.text.startsWith('SELECT count(*) FROM clogs -> 51 users') && tool.text.length <= 400, 'the opening of tool output is kept, briefly');
  assert.ok(!batch.messages.some(m => m.id === 'recall'), 'recalled wiki text is never re-learned');
  assert.ok(batch.messages.filter(m => m.role === 'user').length > batch.messages.filter(m => m.role === 'assistant').length);
  const kinds = []; const worker = new MemoryWorker(store.memory, { synthesize, idleMs: 0, extract: async b => { kinds.push(b.skim ? 'skim' : 'full'); return { facts: b.skim ? [{ topic: 'work/ops', text: 'Deploys on Fridays.', kind: 'fact', sourceMessage: 'u0', quote: 'I always deploy on Fridays.' }] : [] }; } });
  t.after(() => worker.close());
  const later = Date.now() + 1000; await worker.tick(later); await worker.tick(later + 1); await worker.tick(later + 2);
  assert.deepEqual(kinds, ['skim', 'full']);
  assert.ok(store.memory.search('Fridays').some(r => r.kind === 'fact'));
  assert.ok(store.memory.batch('claude:long').messages.length, 'full learning still has the whole conversation to read');
});
