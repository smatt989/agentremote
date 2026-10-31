import { presentMessage } from './presentation.mjs';
import { pendingQuestions } from './questions.mjs';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export const TURN_ACTIVE = ['running','submitting','waiting','compacting'];
const QUEUED = `json_extract(data,'$.queued')=1`; // must match the messages_queued partial index exactly
/**
 * Follow-ups sent while a turn runs (or a question is pending) are stored at once as user rows with queued:true, in
 * transcript order, and delivered one turn per message, oldest first, when the session settles: idle, error or
 * interrupted, with no pending question and no other operation in progress. Delivery flips queued to false and
 * re-stamps completedAt (createdAt keeps the time it was sent) so the row sorts after the reply it waited for, and the
 * rows still waiting move with it; these are row updates, so ?since= deltas carry them. While a turn runs, its newer
 * rows sort after the queued ones, so clients should show queued:true rows last, in seq order. Cancel and end delete the rows (tombstones, so deltas remove them). Interrupt keeps the queue and delivers next.
 * A rate-limit pause holds the queue until the session leaves it, or until the person sends another message.
 */
export function queuedMessages(store, id, limit = 1000) { return store.db.prepare(`SELECT seq,data FROM messages WHERE session=? AND ${QUEUED} ORDER BY seq LIMIT ?`).all(id, limit).map(r => ({ ...JSON.parse(r.data), seq: r.seq })); }
export function presentedMessage(store, id, messageId) {
  const row = store.db.prepare('SELECT seq,data FROM messages WHERE session=? AND id=?').get(id, messageId);
  const shown = row && presentMessage({ ...JSON.parse(row.data), seq: row.seq });
  return shown ? { ...shown, important: false } : null;
}
export function dropQueue(store, id) {
  for (const m of queuedMessages(store, id)) { store.db.prepare(`DELETE FROM messages WHERE session=? AND id=? AND ${QUEUED}`).run(id, m.id); store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('cancelled', m.id); }
}
export class MessageQueue {
  /** `submit(id, {requestId,text,attachments})` starts one turn the way POST /messages does; it must not throw. */
  constructor({ store, providers, submit, interval = 3000 }) {
    Object.assign(this, { store, providers, submit }); this.draining = new Set(); this.timers = new Set(); this.closed = false;
    this.watch = id => this.schedule(id); store.statusWatchers?.add(this.watch);
    this.sweeper = setInterval(() => this.sweep(), interval); this.sweeper.unref?.();
  }
  enqueue(id, { requestId, text, attachments = [] }) {
    this.store.message(id, { id: requestId, role: 'user', kind: 'text', text, queued: true, ...(attachments.length ? { attachments } : {}) });
    this.store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('queued', requestId);
    return presentedMessage(this.store, id, requestId);
  }
  cancel(id, messageId) {
    const request = this.store.db.prepare('SELECT state FROM requests WHERE id=? AND session=?').get(messageId, id);
    if (request?.state === 'cancelled') return { ok: true };
    if (!this.store.db.prepare(`DELETE FROM messages WHERE session=? AND id=? AND ${QUEUED}`).run(id, messageId).changes) {
      if (this.store.db.prepare('SELECT id FROM messages WHERE session=? AND id=?').get(id, messageId) || request) throw fail('This message was already sent.');
      throw fail('Queued message not found.', 404);
    }
    this.store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('cancelled', messageId);
    return { ok: true };
  }
  schedule(id, delay = 0, options) {
    if (this.closed) return;
    const timer = setTimeout(() => { this.timers.delete(timer); this.drain(id, options).catch(() => {}); }, delay); this.timers.add(timer);
  }
  sweep() { if (this.closed) return; try { for (const { session } of this.store.db.prepare(`SELECT DISTINCT session FROM messages WHERE ${QUEUED}`).all()) this.schedule(session); } catch {} }
  // Why the head of the queue cannot go yet: null when it can; 'drop' when the session ended.
  blocked(id, force) {
    const s = this.store.session(id); if (!s) return 'gone';
    if (s.status === 'ended') return 'drop';
    if (['terminal','external-live'].includes(s.control) || TURN_ACTIVE.includes(s.status) || (s.status === 'rate_limited' && !force)) return 'wait';
    if (this.providers.busy?.has(id)) return 'busy';
    return pendingQuestions(this.store, id).length ? 'wait' : null;
  }
  async drain(id, { force = false } = {}) {
    if (this.closed || this.draining.has(id)) return;
    try {
      if (!queuedMessages(this.store, id, 1).length) return;
      let reason = this.blocked(id, force);
      if (reason === 'drop') return dropQueue(this.store, id);
      if (reason === 'busy') return this.schedule(id, 200, { force });
      if (reason) return;
      this.draining.add(id);
      // Codex can report a turn finished (an interrupt) a moment before the thread is ready for the next one.
      if (this.providers.queueReady && !(await this.providers.queueReady(id))) { this.draining.delete(id); return this.schedule(id, 500, { force }); }
      if (this.closed) return;
      reason = this.blocked(id, force); const head = queuedMessages(this.store, id, 1)[0];
      if (reason || !head) { this.draining.delete(id); if (reason === 'busy') this.schedule(id, 200, { force }); return; }
      const now = Date.now();
      if (!this.store.db.prepare(`UPDATE messages SET data=json_set(data,'$.queued',json('false'),'$.completedAt',?) WHERE session=? AND id=? AND ${QUEUED}`).run(now, id, head.id).changes) return;
      // Rows still waiting move after the reply too (seq keeps their order), for clients that do not pin queued rows last.
      this.store.db.prepare(`UPDATE messages SET data=json_set(data,'$.completedAt',?) WHERE session=? AND ${QUEUED}`).run(now, id);
      this.store.db.prepare('UPDATE requests SET state=? WHERE id=?').run('accepted', head.id);
      this.submit(id, { requestId: head.id, text: head.text, attachments: head.attachments || [] });
    } catch {} finally { this.draining.delete(id); }
  }
  close() { this.closed = true; clearInterval(this.sweeper); for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); this.store.statusWatchers?.delete(this.watch); }
}
