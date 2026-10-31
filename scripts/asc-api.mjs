#!/usr/bin/env node
// App Store Connect API client for the Agent Remote release. Requires an Admin team key:
//   ASC_KEY_ID, ASC_ISSUER_ID, and the .p8 at ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
// Usage: node scripts/asc-api.mjs <command> [args]   (see COMMANDS below). Never prints the key.
import { createPrivateKey, sign, randomUUID } from 'node:crypto';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const KEY_ID = process.env.ASC_KEY_ID, ISSUER = process.env.ASC_ISSUER_ID;
if (!KEY_ID || !ISSUER) { console.error('Set ASC_KEY_ID and ASC_ISSUER_ID'); process.exit(2); }
const keyPath = process.env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`;
const privateKey = createPrivateKey(readFileSync(keyPath));
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const payload = b64({ iss: ISSUER, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${header}.${payload}.${sig}`;
}
const BASE = 'https://api.appstoreconnect.apple.com';
export async function api(method, path, body, extraHeaders = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json?.errors ?? json).slice(0, 1500)}`);
  return json;
}
export async function all(path) { let out = [], next = path; while (next) { const page = await api('GET', next); out = out.concat(page.data); next = page.links?.next; } return out; }
const BUNDLE_ID = process.env.ASC_BUNDLE_ID || 'com.agentremote.iphone';
export async function app() {
  const r = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name,bundleId,sku,primaryLocale`);
  if (!r.data.length) throw new Error(`No app record for ${BUNDLE_ID}`);
  return r.data[0];
}
const show = x => console.log(JSON.stringify(x, null, 2));
const COMMANDS = {
  async app() { show(await app()); },
  async builds() {
    const a = await app();
    const r = await api('GET', `/v1/builds?filter[app]=${a.id}&sort=-uploadedDate&limit=10&fields[builds]=version,uploadedDate,processingState,expired,usesNonExemptEncryption,minOsVersion&include=preReleaseVersion&fields[preReleaseVersions]=version`);
    show(r.data.map(b => ({ id: b.id, build: b.version, version: r.included?.find(i => i.id === b.relationships?.preReleaseVersion?.data?.id)?.attributes?.version, ...b.attributes })));
  },
  async versions() {
    const a = await app();
    show((await api('GET', `/v1/apps/${a.id}/appStoreVersions?fields[appStoreVersions]=versionString,appStoreState,appVersionState,platform,releaseType,createdDate`)).data.map(v => ({ id: v.id, ...v.attributes })));
  },
  async get(path) { show(await api('GET', path)); },
  async post(path, json) { show(await api('POST', path, JSON.parse(json))); },
  async patch(path, json) { show(await api('PATCH', path, JSON.parse(json))); },
  async delete(path) { show(await api('DELETE', path)); },
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!COMMANDS[cmd]) { console.error(`Commands: ${Object.keys(COMMANDS).join(', ')}`); process.exit(2); }
  COMMANDS[cmd](...args).catch(e => { console.error(e.message); process.exit(1); });
}
