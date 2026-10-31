import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { missingAgent } from './presentation.mjs';

// Claude Code keeps its claude.ai login in the macOS Keychain. The refresh token carries a hard expiry
// (refreshTokenExpiresAt) that refreshing does not extend, so weeks after /login every new turn fails with
// "OAuth session expired" until someone signs in again. This module watches that expiry, notices the failure,
// and drives `claude auth login` so a paired phone can finish sign-in by pasting the code Anthropic shows.
// Only expiry times leave this module. Tokens are never stored, logged or sent; the fingerprint stays local.
export const AUTH_ERROR = /OAuth session expired|could not be refreshed|Not logged in|Please run \/login|OAuth token (?:has expired|has been revoked)|authentication_error|Invalid bearer token/i;
export const WARN_BEFORE = 3 * 86_400_000;
const LOGIN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function readClaudeCredentials({ env = process.env, run = execFileSync, read = readFileSync } = {}) {
  if (env.AGENT_REMOTE_CLAUDE_CREDENTIALS) { try { return parseCredentials(read(env.AGENT_REMOTE_CLAUDE_CREDENTIALS, 'utf8')); } catch { return null; } }
  const dir = env.CLAUDE_CONFIG_DIR;
  const service = 'Claude Code-credentials' + (dir ? '-' + createHash('sha256').update(dir).digest('hex').slice(0, 8) : '');
  try { return parseCredentials(run('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch (error) {
    // 44: no such item. Only then is the plaintext store authoritative; a locked or failing Keychain is "unknown".
    if (error.status !== 44) return null;
    try { return parseCredentials(read(join(dir || join(homedir(), '.claude'), '.credentials.json'), 'utf8')); } catch { return { signedOut: true }; }
  }
}
export function parseCredentials(text) {
  const oauth = JSON.parse(text)?.claudeAiOauth;
  if (!oauth?.refreshToken && !oauth?.accessToken) return { signedOut: true };
  const time = value => Number.isFinite(value) ? value : null;
  return { fingerprint: createHash('sha256').update(String(oauth.refreshToken || oauth.accessToken)).digest('hex').slice(0, 16), refreshExpiresAt: time(oauth.refreshTokenExpiresAt), accessExpiresAt: time(oauth.expiresAt) };
}
export function loginURL(output) {
  for (const match of output.matchAll(/https:\/\/\S+/g)) {
    try { const url = new URL(match[0]); if (url.protocol === 'https:' && /\/oauth\/authorize$/.test(url.pathname) && LOGIN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return url.href; } catch {}
  }
  return null;
}

export class ClaudeAuth {
  constructor(providers, { credentials = () => readClaudeCredentials(), spawnLogin, now = () => Date.now() } = {}) {
    this.providers = providers; this.store = providers.store; this.readCredentials = credentials; this.now = now;
    this.spawnLogin = spawnLogin || (() => spawn(process.env.AGENT_REMOTE_CLAUDE || 'claude', ['auth', 'login', '--claudeai'], { env: { ...process.env, BROWSER: '/usr/bin/true' }, stdio: ['pipe', 'pipe', 'pipe'] }));
    try { this.failure = JSON.parse(this.store.db.prepare("SELECT value FROM settings WHERE key='claude-auth-failure'").get()?.value || 'null'); } catch { this.failure = null; }
    this.lastState = null;
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { try { this.status(); } catch {} }, 30_000); this.timer.unref(); } }
  close() { clearInterval(this.timer); this.timer = null; this.cancelLogin(); }
  credentials(fresh = false) {
    if (fresh || !this.cached || this.now() - this.cached.at > 30_000) this.cached = { at: this.now(), value: this.readCredentials() };
    return this.cached.value;
  }
  // Internal status: includes the fingerprint-based alert key. Use summary() for anything sent to a phone.
  status() {
    const c = this.credentials(), now = this.now();
    if (this.failure && c?.fingerprint && c.fingerprint !== this.failure.fingerprint) this.recovered();
    let state = 'unknown';
    if (c?.signedOut || (this.failure && (!c || c.fingerprint === this.failure.fingerprint)) || (c?.refreshExpiresAt && c.refreshExpiresAt <= now)) state = 'expired';
    else if (c?.refreshExpiresAt) state = c.refreshExpiresAt - now <= WARN_BEFORE ? 'expiring' : 'ok';
    else if (c?.fingerprint) state = 'ok';
    if (this.lastState === 'expired' && state === 'ok') this.recovered();
    this.lastState = state;
    const login = this.login && !this.login.finished ? { id: this.login.id, url: this.login.url, state: this.login.state } : null;
    return { state, expiresAt: c?.refreshExpiresAt ?? null, login, alertKey: state === 'expired' ? 'expired:' + (c?.fingerprint || this.failure?.at || 'none') : state === 'expiring' ? `expiring:${c.refreshExpiresAt}:${c.refreshExpiresAt - now <= 86_400_000 ? 1 : 3}` : null };
  }
  summary() { const { alertKey, ...value } = this.status(); return value; }
  // A turn failed for lack of a login. The child process caches that state, so it is restarted on the next send.
  noteFailure(id) {
    const c = this.credentials(true);
    this.failure = { fingerprint: c?.fingerprint || null, at: this.now() };
    this.store.db.prepare("INSERT INTO settings VALUES ('claude-auth-failure',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(this.failure));
    const session = id && this.store.session(id); if (session) this.store.save({ ...session, authRequired: true });
    const child = id && this.providers.claude?.get(id);
    if (child) setImmediate(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} });
  }
  // Signed in again (here, at the Mac, or by any other client). Idle Claude processes may still hold the old
  // login in memory, so they are restarted; the next message resumes each conversation from its transcript.
  recovered() {
    this.failure = null; this.lastState = 'ok';
    this.store.db.prepare("DELETE FROM settings WHERE key='claude-auth-failure'").run();
    for (const session of this.store.sessions()) if (session.authRequired) this.store.save({ ...this.store.session(session.id), authRequired: false });
    for (const [id, child] of this.providers.claude || []) {
      const status = this.store.session(id)?.status;
      if (this.providers.busy?.has(id) || ['running', 'submitting', 'waiting', 'compacting'].includes(status)) continue;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    // A shared terminal that failed keeps the expired login in memory too. Once idle, end it so the chat
    // continues in Agent Remote with the new login (pickup reopens it in Terminal) — unless someone has
    // typed into it at the Mac since, e.g. to run /login there.
    for (const [id, terminal] of this.providers.terminals || []) {
      if (terminal.ended || !terminal.authFailedAt || terminal.desktopInputAt > terminal.authFailedAt) continue;
      if (this.providers.busy?.has(id) || ['running', 'submitting', 'waiting', 'compacting'].includes(this.store.session(id)?.status)) continue;
      terminal.close().catch(() => {});
    }
  }
  startLogin() {
    this.cancelLogin();
    const child = this.spawnLogin(), login = { id: randomUUID(), child, output: '', url: null, state: 'starting', finished: false };
    this.login = login;
    const finish = state => { if (login.finished) return; login.finished = true; login.state = state; clearTimeout(login.expiry); try { child.kill('SIGTERM'); } catch {} };
    login.finish = finish;
    login.expiry = setTimeout(() => finish('expired'), 15 * 60_000); login.expiry.unref?.();
    const collect = chunk => { login.output = (login.output + chunk).slice(-20_000); login.changed?.(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.on('error', error => { console.error('Claude sign-in did not start: ' + error.message); login.error = missingAgent('claude', error).message; finish('failed'); login.changed?.(); });
    child.on('exit', code => { login.exitCode = code; if (!login.finished) finish(code === 0 && /Login successful/i.test(login.output) ? 'done' : 'failed'); login.changed?.(); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish('failed'); reject(fail('Claude did not provide a sign-in link. Try again, or run /login on the Mac.', 504)); }, 20_000);
      login.changed = () => {
        if (!login.url) login.url = loginURL(login.output);
        if (login.url && login.state === 'starting') { login.state = 'waiting'; clearTimeout(timer); resolve({ id: login.id, url: login.url }); }
        else if (login.finished && !login.url) { clearTimeout(timer); reject(fail(login.error || 'Claude could not start sign-in. Run /login on the Mac instead.', 502)); }
      };
    });
  }
  async submitCode(id, code) {
    const login = this.login;
    if (!login || login.id !== id || login.finished) throw fail('This sign-in has expired. Start again.');
    if (login.state !== 'waiting') throw fail('This sign-in is already being completed.');
    const value = String(code ?? '').trim();
    if (!value || value.length > 4000 || !/^[A-Za-z0-9_\-#.~=+/]+$/.test(value)) throw fail('Paste the code exactly as shown after you authorize.', 400);
    login.state = 'submitting'; const before = login.output.length;
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 25_000); // inside the service's 30 s request timeout
      login.changed = () => {
        if (/Login successful/i.test(login.output.slice(before))) { clearTimeout(timer); resolve('done'); }
        else if (login.finished) { clearTimeout(timer); resolve('failed'); }
      };
      login.child.stdin.write(value + '\n');
    });
    if (result === 'done') {
      login.finish('done'); this.credentials(true); this.recovered();
      return { ok: true, claudeAuth: this.summary() };
    }
    const detail = login.output.slice(before).replace(/https:\/\/\S+/g, '').split('\n').map(s => s.trim()).filter(Boolean).pop();
    login.finish('failed');
    throw fail((result === 'timeout' ? 'Claude did not confirm the sign-in.' : 'Claude did not accept that code.') + (detail && !/Paste code/i.test(detail) ? ' ' + detail.slice(0, 200) : '') + ' Start again to get a new link.', 422);
  }
  cancelLogin(id) {
    if (this.login && (!id || this.login.id === id) && !this.login.finished) this.login.finish('cancelled');
    return { ok: true };
  }
}
