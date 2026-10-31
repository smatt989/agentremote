import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, randomUUID, diffieHellman, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { hostFingerprint, validateRelayURL } from '../../shared/secure-channel.mjs';

export class RelayState {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_devices (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_invites (id TEXT PRIMARY KEY, secret TEXT NOT NULL, expires INTEGER, consumed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relay_received (channel TEXT, id TEXT, expires INTEGER, PRIMARY KEY(channel,id));`);
    let pem=this.setting('relayPrivateKey');
    if(!pem){pem=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});this.set('relayPrivateKey',pem);}
    this.privateKey=createPrivateKey(pem);
    this.publicKey=createPublicKey(this.privateKey).export({type:'spki',format:'der'});
    this.host=hostFingerprint(this.publicKey);
  }
  setting(key){return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;}
  set(key,value){this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  endpoint(){
    let bundled;try{bundled=JSON.parse(readFileSync(new URL('../relay-default.json',import.meta.url),'utf8')).relay;}catch{}
    const value=process.env.AGENT_REMOTE_RELAY || this.setting('relayURL') || bundled;
    return value ? validateRelayURL(value) : undefined;
  }
  configure(value){const url=validateRelayURL(value);this.set('relayURL',url);return url;}
  invite(){
    const relay=this.endpoint();if(!relay)throw new Error('The relay has not been deployed/configured yet. Run npm run configure -- wss://your-relay-host first.');
    const invite={v:1,relay,host:this.host,channel:randomUUID(),secret:randomBytes(32).toString('base64'),expires:Date.now()+300_000,name:hostname()};
    this.db.prepare('DELETE FROM relay_invites').run();
    this.db.prepare('INSERT INTO relay_invites(id,secret,expires) VALUES (?,?,?)').run(invite.channel,invite.secret,invite.expires);
    return {invite,uri:`agentremote://pair#${Buffer.from(JSON.stringify(invite)).toString('base64url')}`};
  }
  credential(channel){
    const device=this.db.prepare('SELECT r.secret FROM relay_devices r JOIN devices d ON d.id=r.id WHERE r.id=?').get(channel);
    if(device)return {kind:'device',secret:Buffer.from(device.secret,'base64')};
    const invite=this.db.prepare('SELECT secret,consumed FROM relay_invites WHERE id=? AND expires>?').get(channel,Date.now());
    if(invite && !invite.consumed)return {kind:'invite',secret:Buffer.from(invite.secret,'base64')};
  }
  consume(channel,name,clientPublicKey){
    if(typeof name!=='string' || name.length<1 || name.length>100)throw new Error('Invalid device name.');
    if(typeof clientPublicKey!=='string' || Buffer.from(clientPublicKey,'base64').length!==32)throw new Error('Invalid pairing key.');
    const ephemeral=generateKeyPairSync('x25519');
    const publicKey=createPublicKey({key:{kty:'OKP',crv:'X25519',x:Buffer.from(clientPublicKey,'base64').toString('base64url')},format:'jwk'});
    const shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite=this.db.prepare('UPDATE relay_invites SET consumed=1 WHERE id=? AND expires>? AND consumed=0 RETURNING id,secret').get(channel,Date.now());
      if(!invite)throw new Error('This pairing code was already used or has expired. Show a new code on your Mac and scan it again.');
      const paired=this.store.createDevice(name);
      const secret=Buffer.from(hkdfSync('sha256',shared,Buffer.from(invite.secret,'base64'),Buffer.from(`agent-remote/pair/v1/${this.host}/${paired.deviceId}`),32)).toString('base64');
      this.db.prepare('INSERT INTO relay_devices VALUES (?,?)').run(paired.deviceId,secret);
      this.db.exec('COMMIT');return {...paired,host:this.host,name:hostname(),publicKey:Buffer.from(ephemeral.publicKey.export({format:'jwk'}).x,'base64url').toString('base64')};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  receive(packet){
    this.db.prepare('DELETE FROM relay_received WHERE expires<?').run(Date.now());
    return this.db.prepare('INSERT OR IGNORE INTO relay_received VALUES (?,?,?)').run(packet.channel,packet.id,packet.issuedAt+180_000).changes===1;
  }
}
