import { readFile, writeFile, mkdir, cp, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, '../build/website');
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--mac-dmg')) {
  throw new Error('Usage: node website/build.mjs [--mac-dmg /path/to/AgentRemote.dmg]');
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
for (const key of ['macUrl', 'iphoneUrl', 'clientUrl', 'siteUrl', 'repoUrl']) {
  if (config[key] && new URL(config[key]).protocol !== 'https:') throw new Error(`${key} must be an absolute HTTPS URL`);
}
let macUrl = config.macUrl;
// The Mac client zip ships beside the DMG on every GitHub release; config.clientUrl overrides.
const clientUrl = config.clientUrl || (config.macUrl?.endsWith('/AgentRemote.dmg') ? config.macUrl.replace(/AgentRemote\.dmg$/, 'AgentRemoteClient.zip') : '');
let macNote = macUrl ? 'macOS 13.5+ · Apple silicon or Intel' : 'Public download not yet available.';
let digest;
let dmgPath;
if (args[0] === '--mac-dmg') {
  dmgPath = resolve(args[1]);
  const info = await stat(dmgPath);
  if (!info.isFile() || !dmgPath.endsWith('.dmg')) throw new Error('Expected a .dmg file');
  digest = createHash('sha256').update(await readFile(dmgPath)).digest('hex');
  macUrl = 'downloads/AgentRemote.dmg';
  macNote = `Apple silicon + Intel · ${Math.round(info.size / 1024 / 1024)} MB`;
}
const button = (url, label) => `<a class="button primary" href="${escape(url)}">${escape(label)}</a>`;
const unavailable = label => `<span class="unavailable"><span class="status-dot"></span>${label}</span>`;
const replacements = {
  canonical: config.siteUrl ? `<link rel="canonical" href="${escape(config.siteUrl)}"><meta property="og:url" content="${escape(config.siteUrl)}">` : '',
  macAction: macUrl ? button(macUrl, 'Download for Mac') : unavailable('Mac release being prepared'),
  macNote: escape(macNote),
  iphoneAction: config.iphoneUrl ? button(config.iphoneUrl, config.iphoneLabel || 'Get the iPhone app') : unavailable('iPhone release being prepared'),
  iphoneNote: config.iphoneUrl ? 'iOS 17+ · TestFlight beta' : 'Requires iOS 17 or later.',
  repoUrl: escape(config.repoUrl),
  repoApi: escape(config.repoUrl.replace('https://github.com/', 'https://api.github.com/repos/')),
  clientAction: clientUrl ? button(clientUrl, 'Download client') : unavailable('Coming soon'),
  clientNote: 'macOS 14+ · unzip and open',
  clientLink: clientUrl ? `<a class="alt-link" href="${escape(clientUrl)}">${config.iphoneUrl ? 'Or' : 'Until then,'} use Agent Remote Client on another Mac <span aria-hidden="true">↗</span></a><small>The same app for a laptop · macOS 14 or later · unzip and open</small>` : ''
};
let html = await readFile(join(root, 'index.html'), 'utf8');
for (const [, path] of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
  if (!path.startsWith('assets/')) throw new Error(`Expected local image: ${path}`);
  if (!(await stat(join(root, path))).isFile()) throw new Error(`Missing image: ${path}`);
}
html = html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in replacements)) throw new Error(`Unknown template field ${key}`);
  return replacements[key];
});
await mkdir(output, {recursive:true});
await cp(join(root, 'assets'), join(output, 'assets'), {recursive:true});
await copyFile(join(root, 'style.css'), join(output, 'style.css'));
await copyFile(join(root, 'home.css'), join(output, 'home.css'));
await writeFile(join(output, 'index.html'), html);
for (const page of ['privacy.html', 'support.html']) await copyFile(join(root, page), join(output, page));
if (dmgPath) {
  await mkdir(join(output, 'downloads'), {recursive:true});
  await copyFile(dmgPath, join(output, 'downloads/AgentRemote.dmg'));
  await writeFile(join(output, 'downloads/SHA256SUMS'), `${digest}  AgentRemote.dmg\n`);
}
console.log(`Built ${output}\nMac: ${macUrl || 'unavailable'}\niPhone: ${config.iphoneUrl || 'unavailable'}`);
