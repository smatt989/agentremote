import { normalize } from 'node:path';

export function isTemporarySessionDirectory(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return false;
  const path = normalize(cwd);
  return ['/tmp', '/private/tmp'].some(root => path === root || path.startsWith(root + '/'));
}

// Keep explicitly managed scratch sessions accessible, but do not list imported
// temporary jobs or known background helpers. This never deletes history.
export const isListedSession = session => !session.internal &&
  !(session.external === true && isTemporarySessionDirectory(session.cwd));

export function isStateNoteSession(cwd, rows) {
  if (!isTemporarySessionDirectory(cwd)) return false;
  const content = rows.find(row => row.type === 'user')?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : '';
  return /^Keep a running state note for a working session\b/.test(text.trimStart()) &&
    /headline:\s*at most 8 words/i.test(text) && /summary:\s*under 180 words/i.test(text);
}
