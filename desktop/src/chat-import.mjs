import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

// ChatGPT and Claude.ai data exports become hidden, read-only conversations that background learning reads like any
// other session. Parsing runs in a child process: an export can be hundreds of megabytes of JSON, and parsing it on
// the service thread would stall every phone request.
const MAX_EXPORT = 1_500_000_000, MAX_JSON = 700_000_000;
// One extraction call reads about 24 KB of conversation; the estimate uses 20 KB to allow for per-message overhead.
export const charsPerCall = 20_000;
const run = promisify(execFile);
const time = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || '') || null;

function chatgpt(conversation) {
  const mapping = conversation.mapping || {}, path = [];
  // A ChatGPT conversation is a tree of edits and regenerations; the shown branch runs from current_node to the root.
  for (let id = conversation.current_node, seen = new Set(); id && mapping[id] && !seen.has(id); id = mapping[id].parent) { seen.add(id); path.unshift(mapping[id]); }
  const messages = [];
  for (const node of path) {
    const m = node.message, role = m?.author?.role;
    if (!['user', 'assistant'].includes(role) || m.metadata?.is_visually_hidden_from_conversation) continue;
    const content = m.content || {};
    if (!['text', 'multimodal_text'].includes(content.content_type)) continue;
    const text = (content.parts || []).filter(p => typeof p === 'string').join('\n').trim();
    if (text) messages.push({ id: m.id || node.id, role, text, createdAt: time(m.create_time) });
  }
  return { id: String(conversation.conversation_id || conversation.id || ''), title: conversation.title || 'Untitled', createdAt: time(conversation.create_time), updatedAt: time(conversation.update_time), messages };
}
function claude(conversation) {
  const messages = [];
  for (const m of conversation.chat_messages || []) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null; if (!role) continue;
    const text = (typeof m.text === 'string' && m.text.trim() ? m.text : (m.content || []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n')).trim();
    if (text) messages.push({ id: m.uuid, role, text, createdAt: time(m.created_at) });
  }
  return { id: String(conversation.uuid || ''), title: conversation.name || 'Untitled', createdAt: time(conversation.created_at), updatedAt: time(conversation.updated_at), messages };
}
export function parseConversations(list) {
  if (!Array.isArray(list)) throw Error('This file does not contain a list of conversations.');
  const sample = list.find(c => c && typeof c === 'object');
  const source = sample?.mapping ? 'chatgpt' : sample?.chat_messages ? 'claude.ai' : null;
  if (!source) throw Error('This is not a ChatGPT or Claude.ai conversation export.');
  const conversations = list.filter(c => c && typeof c === 'object').map(source === 'chatgpt' ? chatgpt : claude)
    .filter(c => c.id && c.messages.some(m => m.role === 'user') && c.messages.length >= 2)
    .map(c => ({ ...c, updatedAt: c.updatedAt || c.messages.at(-1).createdAt || c.createdAt || 0, chars: c.messages.reduce((n, m) => n + m.text.length, 0) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { source, total: list.length, conversations };
}
/** Reads an export zip (or the conversations.json inside one). */
export function readExport(path) {
  const size = statSync(path).size; if (size > MAX_EXPORT) throw Error('This export is too large to import.');
  let texts;
  if (path.toLowerCase().endsWith('.json')) texts = [readFileSync(path, 'utf8')];
  else {
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 50_000_000 }).split('\n').filter(n => /(^|\/)conversations(-\d+)?\.json$/.test(n));
    if (!entries.length) throw Error('No conversations.json was found in this export. Choose the zip file ChatGPT or Claude.ai emailed you.');
    texts = entries.map(entry => execFileSync('/usr/bin/unzip', ['-p', path, entry], { encoding: 'utf8', maxBuffer: MAX_JSON }));
  }
  const parsed = texts.map(text => parseConversations(JSON.parse(text)));
  return { source: parsed[0].source, total: parsed.reduce((n, p) => n + p.total, 0), conversations: parsed.flatMap(p => p.conversations).sort((a, b) => b.updatedAt - a.updatedAt) };
}
async function inChild(mode, path, limit) {
  const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.url), mode, path, String(limit)], { maxBuffer: 1_000_000_000, timeout: 300_000 });
  const result = JSON.parse(stdout); if (result.error) throw Object.assign(Error(result.error), { status: 400 }); return result;
}
const estimate = (conversations, limit) => conversations.slice(0, limit).reduce((n, c) => n + Math.max(1, Math.ceil(c.chars / charsPerCall)), 0);
export function summarize(parsed) {
  const limits = [50, 200, 1000, parsed.conversations.length].filter((n, i, all) => n <= parsed.conversations.length && all.indexOf(n) === i);
  return { source: parsed.source, total: parsed.total, usable: parsed.conversations.length, newest: parsed.conversations[0]?.updatedAt || null, oldest: parsed.conversations.at(-1)?.updatedAt || null,
    options: limits.map(limit => ({ limit, calls: estimate(parsed.conversations, limit), since: parsed.conversations[limit - 1]?.updatedAt || null })) };
}
export async function previewExport(path) { return inChild('preview', checkPath(path), 0); }
function checkPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || !/\.(zip|json)$/i.test(path)) throw Object.assign(Error('Choose the .zip export (or its conversations.json).'), { status: 400 });
  try { if (!statSync(path).isFile()) throw Error(); } catch { throw Object.assign(Error('That file could not be read.'), { status: 400 }); }
  return path;
}
/** Adds the newest `limit` conversations as hidden sessions. Re-importing the same export updates them in place. */
export async function importExport(store, path, limit) {
  limit = Math.floor(Number(limit)); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw Object.assign(Error('Choose how many conversations to import.'), { status: 400 });
  const parsed = await inChild('read', checkPath(path), limit), batch = randomUUID(), now = Date.now();
  const sessions = parsed.conversations.map(c => ({ id: `import:${parsed.source}:${c.id}`.slice(0, 200), c }));
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const { id, c } of sessions) {
      // An explicit re-import brings back a conversation the user removed earlier.
      store.db.prepare('DELETE FROM deleted_sessions WHERE id=?').run(id);
      const session = { id, provider: 'import', importSource: parsed.source, importBatch: batch, title: String(c.title).slice(0, 200), status: 'ended', external: true, internal: true, createdAt: c.createdAt || c.updatedAt || now, updatedAt: c.updatedAt || now, lastMessageAt: c.updatedAt || now };
      store.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(session));
      c.messages.forEach((m, i) => {
        const data = { id: String(m.id || i), role: m.role, kind: 'text', text: m.text, createdAt: m.createdAt || session.createdAt, completedAt: m.createdAt || session.createdAt, partial: false };
        store.db.prepare('INSERT INTO messages(session,id,data) VALUES (?,?,?) ON CONFLICT(session,id) DO NOTHING').run(id, data.id, JSON.stringify(data));
      });
      // There is no provider history to load for an import.
      store.db.prepare('INSERT INTO memory_history VALUES(?,?) ON CONFLICT(session) DO UPDATE SET updated=excluded.updated').run(id, session.updatedAt);
    }
    const imports = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='knowledge-imports'").get()?.value || '[]');
    imports.unshift({ id: batch, source: parsed.source, file: basename(path), at: now, conversations: sessions.length, sessionIDs: sessions.map(s => s.id) });
    store.db.prepare("INSERT INTO settings VALUES('knowledge-imports',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(imports.slice(0, 50)));
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { id: batch, source: parsed.source, conversations: sessions.length };
}
export function imports(store) {
  const list = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='knowledge-imports'").get()?.value || '[]');
  return list.map(({ sessionIDs, ...item }) => {
    const present = sessionIDs.filter(id => store.session(id)?.importBatch === item.id);
    const learned = present.filter(id => (store.db.prepare('SELECT seq FROM memory_cursors WHERE session=?').get(id)?.seq || 0) >= (store.db.prepare('SELECT max(seq) seq FROM messages WHERE session=?').get(id)?.seq || 0)).length;
    return { ...item, conversations: present.length, learned };
  }).filter(item => item.conversations);
}
/** Removes an import's conversations and everything learned from them. */
export function removeImport(store, batch) {
  const list = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='knowledge-imports'").get()?.value || '[]');
  const item = list.find(i => i.id === batch); if (!item) throw Object.assign(Error('That import was not found.'), { status: 404 });
  const ids = item.sessionIDs.filter(id => store.session(id)?.importBatch === batch);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) for (const table of ['messages', 'memory_facts', 'memory_cursors', 'memory_history', 'memory_hidden_sources', 'sessions']) store.db.prepare(`DELETE FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session'}=?`).run(id);
    for (const id of ids) store.db.prepare('DELETE FROM settings WHERE key=?').run('memory-offset:' + id);
    store.db.prepare("UPDATE settings SET value=? WHERE key='knowledge-imports'").run(JSON.stringify(list.filter(i => i.id !== batch)));
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  for (const id of ids) store.memory.exportSession(id);
  store.knowledge.refresh();
  return { removed: ids.length };
}
export const importedSessions = store => store.db.prepare("SELECT data FROM sessions WHERE json_extract(data,'$.provider')='import'").all().map(r => JSON.parse(r.data));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, path, limit] = process.argv.slice(2);
  try {
    const parsed = readExport(path);
    process.stdout.write(JSON.stringify(mode === 'preview' ? summarize(parsed) : { source: parsed.source, conversations: parsed.conversations.slice(0, Number(limit)).map(({ chars, ...c }) => c) }));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof SyntaxError ? 'The export could not be read as JSON.' : error.message })); }
}
