import { statSync } from 'node:fs';
import { homedir } from 'node:os';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// A chat named from its first message, without a model call: first non-empty line, whitespace collapsed, ≤60 characters.
export function autoTitle(text, max = 60) {
  const line = String(text ?? '').split(/\r?\n|\r/).map(s => s.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1), word = line[max - 1] === ' ' ? cut : cut.replace(/\s+\S*$/, '');
  return (word.length >= max / 2 ? word : cut).replace(/[\s,;:.-]+$/, '') + '…';
}
/** Title fields to merge when a blank or placeholder ("New session") chat gets its first user message; {} otherwise. Real titles are never replaced. */
export function autoTitlePatch(store, session, text) {
  if (!session || (session.title?.trim() && session.title.trim() !== 'New session')) return {};
  // Called after the message is stored, so a first message counts itself.
  const users = store.db.prepare(`SELECT count(*) AS n FROM messages WHERE session=? AND json_extract(data,'$.role')='user'`).get(session.id).n;
  const title = autoTitle(text);
  return users > 1 || !title ? {} : { title, titleSource: 'prompt' };
}
/** POST /sessions/:id/title. A stored 'custom' title wins over Claude's and Codex's own names on every later refresh. */
export function renameSession(store, id, value) {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > 120) throw fail('Enter a title of 1 to 120 characters.');
  const session = store.session(id); if (!session) throw fail('Session not found.', 404);
  store.save({ ...session, title, titleSource: 'custom' });
  return { session: store.sessionView(store.session(id)) };
}
/** GET /folders/recent: distinct working folders of listed sessions, newest first, that still exist. Home is returned separately. */
export function recentFolders(store, { home = homedir(), limit = 12 } = {}) {
  const seen = new Map();
  for (const s of store.listedSessions()) {
    if (typeof s.cwd !== 'string' || !s.cwd.startsWith('/')) continue;
    const path = s.cwd.length > 1 ? s.cwd.replace(/\/+$/, '') : s.cwd, at = s.lastMessageAt || s.updatedAt || s.createdAt || 0;
    if (path !== home && at > (seen.get(path) ?? -1)) seen.set(path, at);
  }
  const folders = [];
  for (const [path, lastUsed] of [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (folders.length >= limit) break;
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    folders.push({ path, label: path.startsWith(home + '/') ? '~' + path.slice(home.length) : path, lastUsed });
  }
  return { home, folders };
}
