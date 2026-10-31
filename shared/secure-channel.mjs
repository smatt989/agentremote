import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';

export const MAX_PACKET_BYTES = 40_000_000;
export const MAX_CLOCK_SKEW = 120_000;
const identifier = /^[A-Za-z0-9_-]{1,100}$/;
export const hostFingerprint = publicKeyDER => createHash('sha256').update(publicKeyDER).digest('hex');
export function validateRelayURL(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'wss:' || (local && url.protocol === 'ws:')) || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('Relay must use wss:// with no path, credentials, or query. Local development may use ws://localhost.');
  return url.origin;
}
export function validatePacket(packet, now = Date.now()) {
  if (packet?.v !== 1 || typeof packet.host !== 'string' || !/^[a-f0-9]{64}$/.test(packet.host) || typeof packet.channel !== 'string' || !identifier.test(packet.channel) || typeof packet.id !== 'string' || !identifier.test(packet.id) || !Number.isSafeInteger(packet.issuedAt) || Math.abs(now-packet.issuedAt)>MAX_CLOCK_SKEW || typeof packet.box !== 'string' || packet.box.length>MAX_PACKET_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(packet.box)) throw new Error('Invalid or expired encrypted packet.');
}
export function channelKey(secret, header, direction) {
  if (!['request','response'].includes(direction) || secret.length!==32) throw new Error('Invalid channel key.');
  return Buffer.from(hkdfSync('sha256',secret,Buffer.from(header.host),Buffer.from(`agent-remote/v1/${header.channel}/${direction}`),32));
}
export function authenticatedHeader(header, direction) {
  return Buffer.from(`agent-remote/v1\n${header.host}\n${header.channel}\n${header.id}\n${header.issuedAt}\n${direction}`);
}
export function seal(secret, header, value, direction, nonce = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm',channelKey(secret,header,direction),nonce);
  cipher.setAAD(authenticatedHeader(header,direction));
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const packet = {v:1,host:header.host,channel:header.channel,id:header.id,issuedAt:header.issuedAt,box:Buffer.concat([nonce,ciphertext,cipher.getAuthTag()]).toString('base64')};
  validatePacket(packet); return packet;
}
export function open(secret, packet, direction) {
  validatePacket(packet);
  const combined = Buffer.from(packet.box,'base64');
  if (combined.length<28) throw new Error('Truncated encrypted packet.');
  const decipher = createDecipheriv('aes-256-gcm',channelKey(secret,packet,direction),combined.subarray(0,12));
  decipher.setAAD(authenticatedHeader(packet,direction)); decipher.setAuthTag(combined.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(12,-16)),decipher.final()]).toString('utf8'));
}
