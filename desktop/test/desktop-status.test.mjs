import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.mjs';
import {RelayState} from '../src/relay-state.mjs';
import {desktopStatus,writeDesktopStatus,clearDesktopStatus} from '../src/desktop-status.mjs';
const exec=promisify(execFile);
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'agentremote-wrapper-'));const store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;
}
test('desktop status contains only operational counts and clears only its own process record',t=>{
  const store=fixture(t);store.save({id:'private-session',title:'secret title',status:'running',external:false});
  store.save({id:'external',status:'running',external:true});store.createDevice('private phone');
  const status=desktopStatus(store,{port:8787,relay:'connected'});assert.equal(status.activeSessions,1);assert.equal(status.pairedDevices,1);
  assert.deepEqual(Object.keys(status).sort(),['activeSessions','pairedDevices','pid','port','relay','updatedAt']);
  writeDesktopStatus(store,{port:8787,relay:'connected'});
  const path=join(store.directory,'desktop-status.json');assert.equal(statSync(path).mode & 0o777,0o600);
  assert.equal(readFileSync(path,'utf8').includes('secret'),false);
  writeFileSync(path,JSON.stringify({...status,pid:process.pid+1}));clearDesktopStatus(store);assert.equal(existsSync(path),true);
  writeDesktopStatus(store,{port:8787,relay:'connected'});clearDesktopStatus(store);assert.equal(existsSync(path),false);
});
test('native QR command produces a valid PNG and an expiring single-use invitation in private state',async t=>{
  const store=fixture(t);const state=new RelayState(store);state.configure('wss://relay.example.com');
  const {stdout}=await exec(process.execPath,['desktop/src/admin.mjs','pair-native'],{env:{...process.env,AGENT_REMOTE_STATE:store.directory,NODE_NO_WARNINGS:'1'}});
  const result=JSON.parse(stdout);assert.ok(result.expires>Date.now());assert.ok(result.expires<=Date.now()+300_000);
  assert.ok(result.image.startsWith('data:image/png;base64,'));assert.equal(Buffer.from(result.image.split(',')[1],'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM relay_invites').get().count,1);
  const info=await exec(process.execPath,['desktop/src/admin.mjs','desktop-info'],{env:{...process.env,AGENT_REMOTE_STATE:store.directory,NODE_NO_WARNINGS:'1'}});
  assert.deepEqual(JSON.parse(info.stdout),{activeSessions:0,pairedDevices:0});
});

test('Mac conversation credential persists privately without consuming phone pairings',t=>{
  const store=fixture(t);const phone=store.createDevice('Phone');const token=store.desktopToken();
  assert.equal(token.length,43);assert.equal(store.authenticate(token),true);assert.equal(store.authenticate(phone.token),true);
  assert.equal(store.desktopToken(),token);assert.equal(desktopStatus(store).pairedDevices,1);
  assert.equal(statSync(join(store.directory,'desktop-token')).mode & 0o777,0o600);
  assert.notEqual(store.db.prepare('SELECT value FROM settings WHERE key=?').get('desktopTokenHash').value,token);
  const second=new Store(store.directory);assert.equal(second.desktopToken(),token);second.close();
  rmSync(join(store.directory,'desktop-token'));const replacement=store.desktopToken();assert.notEqual(replacement,token);assert.equal(store.authenticate(token),false);assert.equal(store.authenticate(phone.token),true);
});
