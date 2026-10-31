#!/usr/bin/env node
// Finds or creates the Developer ID (MAC_CATALYST_APP_DIRECT) profile for the Mac client, signed by the
// Developer ID certificate in this Mac's keychain, and installs it where xcodebuild looks. Prints its UUID.
// Env: ASC_KEY_ID, ASC_ISSUER_ID. Arg: serial number of the local Developer ID Application certificate.
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { api } from './asc-api.mjs';
const NAME = 'Agent Remote Client Developer ID';
const serial = (process.argv[2] || '').toUpperCase();
const certs = await api('GET', '/v1/certificates?limit=100&filter[certificateType]=DEVELOPER_ID_APPLICATION&fields[certificates]=serialNumber');
const cert = certs.data.find(c => c.attributes.serialNumber.toUpperCase() === serial);
if (!cert) throw new Error(`No Developer ID certificate with serial ${serial} in the developer account`);
const bundle = (await api('GET', '/v1/bundleIds?filter[identifier]=com.agentremote.iphone')).data.find(b => b.attributes.identifier === 'com.agentremote.iphone');
const existing = await api('GET', `/v1/profiles?filter[name]=${encodeURIComponent(NAME)}&filter[profileState]=ACTIVE&include=certificates&fields[profiles]=name,uuid,profileContent,certificates`);
let profile = existing.data.find(p => p.relationships?.certificates?.data?.some(c => c.id === cert.id));
if (!profile) {
  for (const stale of existing.data) await api('DELETE', `/v1/profiles/${stale.id}`); // names must be unique
  profile = (await api('POST', '/v1/profiles', { data: { type: 'profiles', attributes: { name: NAME, profileType: 'MAC_CATALYST_APP_DIRECT' },
    relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } } } })).data;
}
const dir = join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${profile.attributes.uuid}.provisionprofile`), Buffer.from(profile.attributes.profileContent, 'base64'));
console.log(profile.attributes.uuid);
