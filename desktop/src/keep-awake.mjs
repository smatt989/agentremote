import { spawn } from 'node:child_process';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const ACTIVE = ['running', 'submitting', 'waiting'];
// Stored in the settings table so the Mac app (admin.mjs keep-awake) and the running service share one value.
export const keepAwakeEnabled = store => store.db.prepare("SELECT value FROM settings WHERE key='keepAwake'").get()?.value !== 'false';
export function setKeepAwake(store, enabled) {
  if (typeof enabled !== 'boolean') throw fail('Send {"enabled": true} or {"enabled": false}.');
  store.db.prepare("INSERT INTO settings VALUES ('keepAwake',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(enabled));
  return { enabled };
}
/**
 * While a managed session is working, hold `caffeinate -i -s -w <service pid>` so the Mac does not idle-sleep mid-turn.
 * -w ends the assertion if this service dies without cleaning up; close() and process exit kill it too.
 */
export class KeepAwake {
  constructor(store, { spawnHold = pid => spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(pid)], { stdio: 'ignore' }), pid = process.pid, interval = 5000 } = {}) {
    Object.assign(this, { store, spawnHold, pid, interval }); this.child = null;
    this.onExit = () => this.release();
  }
  active() { return this.store.listedSessions().some(s => s.external === false && ACTIVE.includes(s.status)); }
  update() {
    let want = false; try { want = keepAwakeEnabled(this.store) && this.active(); } catch {}
    if (want && !this.child) {
      const child = this.spawnHold(this.pid); this.child = child;
      child.on?.('error', error => { console.error('Keep awake could not start: ' + error.message); if (this.child === child) this.child = null; });
      child.on?.('exit', () => { if (this.child === child) this.child = null; });
    } else if (!want) this.release();
    return !!this.child;
  }
  release() { const child = this.child; this.child = null; if (child && child.exitCode == null) try { child.kill('SIGTERM'); } catch {} }
  start() { if (!this.timer) { this.timer = setInterval(() => this.update(), this.interval); this.timer.unref(); process.once('exit', this.onExit); this.update(); } return this; }
  close() { clearInterval(this.timer); this.timer = null; process.off('exit', this.onExit); this.release(); }
}
