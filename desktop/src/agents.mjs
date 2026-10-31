import { execFile } from 'node:child_process';
import { accessSync, readdirSync, statSync, constants } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// The folders the Mac app puts on the service's PATH (AgentRemote.swift searchDirectories), so a development checkout
// started from a bare shell finds the same CLIs the installed app does.
export function agentSearchPath(env = process.env, home = homedir()) {
  const dirs = [...(env.PATH || '').split(delimiter), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.volta/bin'), join(home, '.asdf/shims'), '/usr/bin', '/bin'];
  try { dirs.push(...readdirSync(join(home, '.nvm/versions/node')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(v => join(home, '.nvm/versions/node', v, 'bin'))); } catch {}
  return [...new Set(dirs.filter(Boolean))];
}
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
/** Absolute path of an agent CLI, honouring the AGENT_REMOTE_CLAUDE / AGENT_REMOTE_CODEX overrides the providers use. */
export function resolveAgent(name, env = process.env, home = homedir()) {
  const command = env['AGENT_REMOTE_' + name.toUpperCase()] || name;
  if (command.includes('/')) return isAbsolute(command) && executable(command) ? command : null;
  for (const dir of agentSearchPath(env, home)) if (executable(join(dir, command))) return join(dir, command);
  return null;
}
const run = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 8000, env: { ...process.env, PATH: agentSearchPath().join(delimiter) } }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0)));

/** GET /agents: whether each CLI is installed and signed in. Cached ~30 s so polling from the phone stays cheap. */
export class AgentReadiness {
  constructor({ claudeAuth = () => null, resolve = resolveAgent, exec = run, now = () => Date.now(), ttl = 30_000 } = {}) { Object.assign(this, { claudeAuth, resolve, exec, now, ttl }); }
  async list() {
    if (this.cached && this.now() - this.cached.at < this.ttl) return this.cached.value;
    this.pending ||= this.read().then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async read() {
    const claude = this.resolve('claude'), codex = this.resolve('codex');
    let state; try { state = this.claudeAuth()?.summary?.().state; } catch {}
    const claudeSignedIn = !claude ? null : ['ok', 'expiring'].includes(state) ? true : state === 'expired' ? false : null;
    // `codex login status` exits 0 when signed in and non-zero when not; a timeout or failed start is unknown (null).
    const code = codex ? await this.exec(codex, ['login', 'status']) : null;
    return { agents: [{ id: 'claude', name: 'Claude', installed: !!claude, signedIn: claudeSignedIn }, { id: 'codex', name: 'Codex', installed: !!codex, signedIn: typeof code === 'number' ? code === 0 : null }] };
  }
}
