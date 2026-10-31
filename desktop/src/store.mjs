import { isListedSession } from './session-visibility.mjs';
import { Knowledge } from './knowledge.mjs';
import { initMemory, Memory } from './memory.mjs';
import { initQuestions } from './questions.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const stateDirectory = () => process.env.AGENT_REMOTE_STATE || join(homedir(), 'Library', 'Application Support', 'AgentRemote');
const echoText = value => (value||'').normalize('NFC').replaceAll('\r\n','\n').replaceAll('\r','\n').trim();
export const digest = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(directory = stateDirectory()) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'state.sqlite'));
    chmodSync(join(directory, 'state.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, hash TEXT UNIQUE, created INTEGER);
      CREATE TABLE IF NOT EXISTS pairing (hash TEXT PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS session_reads(session TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, id TEXT, data TEXT, UNIQUE(session,id));
      -- sessionView's latest-message lookup reads one row from this instead of sorting the whole conversation.
      CREATE INDEX IF NOT EXISTS messages_latest ON messages(session,coalesce(json_extract(data,'$.completedAt'),json_extract(data,'$.createdAt'),0),seq);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, session TEXT, fingerprint TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session TEXT, name TEXT, path TEXT, mime TEXT);
      -- Follow-ups sent while a turn runs wait as user rows with queued:true (message-queue.mjs); this keeps their lookups off the full table.
      CREATE INDEX IF NOT EXISTS messages_queued ON messages(session,seq) WHERE json_extract(data,'$.queued')=1;
    `);
    // Called with (id,status,previous) whenever a saved session's status changes; the follow-up queue drains on these.
    this.statusWatchers = new Set();
    this.initMessageRevisions();
    initMemory(this.db); initQuestions(this.db); this.memory = new Memory(this); this.knowledge = new Knowledge(this);
    if (!this.db.prepare('SELECT value FROM settings WHERE key=?').get('hostId')) this.db.prepare('INSERT INTO settings VALUES (?,?)').run('hostId', randomUUID());
  }
  // Every insert, update and delete of a message gets a global revision (triggers, so direct SQL elsewhere is covered too).
  // Clients poll GET /sessions/:id?since=<revision> and receive only rows changed since then, plus tombstones.
  initMessageRevisions() {
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'rev')) this.db.exec('ALTER TABLE messages ADD COLUMN rev INTEGER');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_revision (id INTEGER PRIMARY KEY CHECK (id=1), n INTEGER NOT NULL);
      INSERT OR IGNORE INTO message_revision VALUES (1,0);
      CREATE TABLE IF NOT EXISTS message_tombstones (session TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_tombstones_session ON message_tombstones(session,rev);
      CREATE INDEX IF NOT EXISTS messages_rev ON messages(session,rev);
      CREATE TRIGGER IF NOT EXISTS messages_rev_insert AFTER INSERT ON messages BEGIN
        UPDATE message_revision SET n=n+1 WHERE id=1;
        UPDATE messages SET rev=(SELECT n FROM message_revision WHERE id=1) WHERE seq=new.seq;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_rev_update AFTER UPDATE OF session,id,data ON messages BEGIN
        UPDATE message_revision SET n=n+1 WHERE id=1;
        UPDATE messages SET rev=(SELECT n FROM message_revision WHERE id=1) WHERE seq=new.seq;
        INSERT INTO message_tombstones SELECT old.session,old.id,(SELECT n FROM message_revision WHERE id=1),unixepoch()*1000 WHERE old.id<>new.id OR old.session<>new.session;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_rev_delete AFTER DELETE ON messages BEGIN
        UPDATE message_revision SET n=n+1 WHERE id=1;
        INSERT INTO message_tombstones VALUES (old.session,old.id,(SELECT n FROM message_revision WHERE id=1),unixepoch()*1000);
      END;`);
    // Tombstones older than a week are dropped; a client whose cursor predates them gets a full page instead.
    const pruned = this.db.prepare('SELECT max(rev) AS rev FROM message_tombstones WHERE at<?').get(Date.now() - 7 * 86_400_000).rev;
    if (pruned) {
      this.db.prepare('DELETE FROM message_tombstones WHERE rev<=?').run(pruned);
      this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=max(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))').run('messageTombstoneFloor', String(pruned));
    }
  }
  get messageRevision() { return this.db.prepare('SELECT n FROM message_revision WHERE id=1').get().n; }
  /** The latest revision that touched this session (rows or tombstones); keys per-session memos. */
  sessionRevision(session) {
    const rows = this.db.prepare('SELECT max(rev) AS rev, count(*) AS n FROM messages WHERE session=?').get(session);
    const gone = this.db.prepare('SELECT max(rev) AS rev FROM message_tombstones WHERE session=?').get(session).rev;
    return `${Math.max(rows.rev || 0, gone || 0)}:${rows.n}`;
  }
  /** Rows changed and ids removed since `since`, or null when the caller must take a full page instead. */
  messageChanges(session, since, limit = 400) {
    const cursor = this.messageRevision; // read first: anything written after this is sent again next time, never missed
    const floor = Number(this.db.prepare('SELECT value FROM settings WHERE key=?').get('messageTombstoneFloor')?.value || 0);
    if (!Number.isSafeInteger(since) || since < floor || since > cursor) return null;
    const rows = this.db.prepare('SELECT seq,id,data FROM messages WHERE session=? AND rev>? ORDER BY rev LIMIT ?').all(session, since, limit + 1);
    if (rows.length > limit) return null;
    const messages = rows.map(row => ({ ...JSON.parse(row.data), seq: row.seq })), live = new Set(rows.map(row => row.id));
    const removed = [...new Set(this.db.prepare('SELECT id FROM message_tombstones WHERE session=? AND rev>?').all(session, since).map(r => r.id))].filter(id => !live.has(id));
    return { cursor, messages, removed };
  }
  get hostId() { return this.db.prepare('SELECT value FROM settings WHERE key=?').get('hostId').value; }
  pairCode() {
    const code = randomBytes(24).toString('base64url');
    this.db.prepare('DELETE FROM pairing').run();
    this.db.prepare('INSERT INTO pairing VALUES (?,?)').run(digest(code), Date.now() + 5 * 60_000);
    return code;
  }
  pair(code, name) {
    const row = this.db.prepare('DELETE FROM pairing WHERE hash=? AND expires>? RETURNING hash').get(digest(code), Date.now());
    if (!row) throw Object.assign(new Error('Pairing code is invalid or expired.'), { status: 401 });
    return this.createDevice(name);
  }
  createDevice(name) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    this.db.prepare('INSERT INTO devices VALUES (?,?,?,?)').run(id, name.slice(0, 100), digest(token), Date.now());
    return { token, deviceId: id, hostId: this.hostId };
  }
  desktopToken() {
    const path = join(this.directory, 'desktop-token');
    if (existsSync(path)) {
      const token = readFileSync(path, 'utf8').trim();
      if (this.db.prepare('SELECT value FROM settings WHERE key=?').get('desktopTokenHash')?.value === digest(token)) return token;
    }
    const token = randomBytes(32).toString('base64url');
    writeFileSync(path, token, {mode:0o600}); chmodSync(path,0o600);
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('desktopTokenHash', digest(token));
    return token;
  }
  authenticateDesktop(token) {
    return typeof token==='string' && this.db.prepare('SELECT value FROM settings WHERE key=?').get('desktopTokenHash')?.value===digest(token);
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const hash = Buffer.from(digest(token));
    const local = this.db.prepare('SELECT value FROM settings WHERE key=?').get('desktopTokenHash')?.value;
    if (local && timingSafeEqual(hash, Buffer.from(local))) return true;
    return this.db.prepare('SELECT hash FROM devices').all().some(row => timingSafeEqual(hash, Buffer.from(row.hash)));
  }
  modelDefaults() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('modelDefaults');
    return row ? JSON.parse(row.value) : { codex: '', claude: '', local: '', localProvider: 'ollama' };
  }
  setModelDefaults(value) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('modelDefaults', JSON.stringify(value));
    return value;
  }
  deleted(id) { return !!this.db.prepare('SELECT id FROM deleted_sessions WHERE id=?').get(id); }
  deleteSession(id) {
    const session = this.session(id);
    if (session) rmSync(join(this.directory, 'artifacts', encodeURIComponent(session.artifactKey || id)), { recursive: true, force: true });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO deleted_sessions VALUES (?)').run(id);
      for (const table of ['session_reads', 'messages', 'requests', 'artifacts', 'questions', 'memory_facts', 'memory_cursors', 'memory_history', 'memory_hidden_sources']) this.db.prepare(`DELETE FROM ${table} WHERE session=?`).run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_receipts'").get())this.db.prepare('DELETE FROM push_receipts WHERE session=?').run(id);
      this.db.prepare('DELETE FROM settings WHERE key=?').run('session-run:'+id);
      this.db.prepare("DELETE FROM settings WHERE substr(key,1,?)=?").run(('handoff:'+id+':').length,'handoff:'+id+':');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.memory.exportSession(id);
    this.knowledge.refresh();
  }
  save(session) {
    if (this.deleted(session.id)) return session; const old=this.session(session.id); session={createdAt:old?.createdAt??session.updatedAt??Date.now(),...session};
    this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id, JSON.stringify(session));
    if (old?.status !== session.status) for (const watch of this.statusWatchers) try { watch(session.id, session.status, old?.status); } catch {}
    return session;
  }
  session(id) { const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id); return row && JSON.parse(row.data); }
  sessionView(session) {
    if(!session)return session;
    const latest=role=>this.db.prepare(`SELECT data FROM messages WHERE session=? AND json_extract(data,'$.kind')='text'
      AND json_extract(data,'$.role') IN ('user','assistant') AND (?='' OR json_extract(data,'$.role')=?)
      AND coalesce(json_extract(data,'$.partial'),0)=0 AND length(trim(json_extract(data,'$.text')))>0
      ORDER BY coalesce(json_extract(data,'$.completedAt'),json_extract(data,'$.createdAt'),0) DESC,seq DESC LIMIT 1`).get(session.id,role,role);
    const last=latest('');const assistant=latest('assistant');const message=last&&JSON.parse(last.data);const response=assistant&&JSON.parse(assistant.data);
    const lastCompletedAt=message?.completedAt??message?.createdAt??null;
    const latestAssistantToken=response?digest(JSON.stringify([session.id,response.id,response.completedAt??response.createdAt,response.text])):null;
    const read=this.db.prepare('SELECT token FROM session_reads WHERE session=?').get(session.id);
    const queued=this.db.prepare(`SELECT count(*) AS n FROM messages WHERE session=? AND json_extract(data,'$.queued')=1`).get(session.id).n;
    return {...session,queued,lastCompletedAt,lastCompletedRole:message?.role??null,latestAssistantMessageId:response?.id??null,latestAssistantToken,
      unread:!!latestAssistantToken&&read?.token!==latestAssistantToken,updatedAt:lastCompletedAt??session.createdAt??session.updatedAt};
  }
  // Stored session records without the per-session message lookups of sessionView, for status checks on timers.
  listedSessions() { return this.db.prepare('SELECT data FROM sessions').all().map(row=>JSON.parse(row.data)).filter(isListedSession); }
  sessions() { return this.listedSessions().map(session=>this.sessionView(session)); }
  markRead(id,token) {
    // A receipt applies only to the exact response the UI displayed. A newer
    // response arriving between GET and POST must remain unread.
    const current=this.sessionView(this.session(id));
    if(current?.latestAssistantToken===token)this.db.prepare('INSERT INTO session_reads VALUES(?,?) ON CONFLICT(session) DO UPDATE SET token=excluded.token').run(id,token);
    return this.sessionView(this.session(id));
  }
  message(session, message) {
    if (this.deleted(session)) return;
    const old = this.db.prepare('SELECT data FROM messages WHERE session=? AND id=?').get(session, message.id);
    const data = { createdAt: Date.now(), ...(old ? JSON.parse(old.data) : {}), ...message,partial:message.partial??false };
    this.db.prepare('INSERT INTO messages(session,id,data) VALUES (?,?,?) ON CONFLICT(session,id) DO UPDATE SET data=excluded.data').run(session, message.id, JSON.stringify(data));
    if(['user','assistant'].includes(data.role)&&data.kind==='text'&&data.text?.trim()&&!data.partial){
      const previous=old&&JSON.parse(old.data);
      const timestamp=previous&&!previous.partial?(previous.completedAt??previous.createdAt??data.completedAt??Date.now()):(message.completedAt??Date.now());
      if(data.completedAt!==timestamp){data.completedAt=timestamp;this.db.prepare('UPDATE messages SET data=? WHERE session=? AND id=?').run(JSON.stringify(data),session,message.id);}
      const current=this.session(session);if(current&&timestamp>(current.lastMessageAt||0))this.save({...current,lastMessageAt:timestamp});
    }
    return data;
  }
  userAcknowledgement(session, message) {
    const pending = this.messages(session).findLast(m => m.role === 'user' && !m.queued && echoText(m.text) === echoText(message.text) && !m.requestAcknowledged && (!message.completedAt || message.completedAt >= m.createdAt) && m.id !== message.id && this.db.prepare('SELECT id FROM requests WHERE id=?').get(m.id));
    if (pending) {
      const acknowledged={...pending,...message,requestId:pending.requestId||pending.id,requestAcknowledged:true};
      if(this.db.prepare('SELECT seq FROM messages WHERE session=? AND id=?').get(session,message.id)){
        this.message(session,acknowledged);this.db.prepare('DELETE FROM messages WHERE session=? AND id=?').run(session,pending.id);
      }else this.db.prepare('UPDATE messages SET id=?,data=? WHERE session=? AND id=?').run(message.id,JSON.stringify(acknowledged),session,pending.id);
      return;
    }
    this.message(session,message);
  }
  append(session, id, text, role = 'assistant', kind = 'text') {
    const old = this.db.prepare('SELECT data FROM messages WHERE session=? AND id=?').get(session, id);
    return this.message(session, { id, role, kind, text: (old ? JSON.parse(old.data).text : '') + text,partial:true });
  }
  messages(session, before = Number.MAX_SAFE_INTEGER) {
    // History can arrive after live replies. Page by source time, with seq as a tie breaker.
    const time = "coalesce(json_extract(data,'$.completedAt'),json_extract(data,'$.createdAt'),0)";
    const cursor = before === Number.MAX_SAFE_INTEGER ? null : this.db.prepare(`SELECT ${time} AS time,seq FROM messages WHERE session=? AND seq=?`).get(session,before);
    if(before !== Number.MAX_SAFE_INTEGER && !cursor)return [];
    const rows = cursor
      ? this.db.prepare(`SELECT seq,data FROM messages WHERE session=? AND (${time},seq)<(?,?) ORDER BY ${time} DESC,seq DESC LIMIT 200`).all(session,cursor.time,cursor.seq)
      : this.db.prepare(`SELECT seq,data FROM messages WHERE session=? ORDER BY ${time} DESC,seq DESC LIMIT 200`).all(session);
    return rows.reverse().map(row => ({ ...JSON.parse(row.data), seq: row.seq }));
  }
  claim(id, session, content) {
    const fingerprint = digest(JSON.stringify(content));
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (row) {
      if (row.session !== session || row.fingerprint !== fingerprint) throw Object.assign(new Error('Message ID reused for different content.'), { status: 409 });
      return false;
    }
    this.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(id, session, fingerprint, 'accepted');
    return true;
  }
  close() { this.db.close(); }
}
