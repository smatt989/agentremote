#!/usr/bin/env python3
"""Download a 30 MB file with the app's own code over a real (local) encrypted relay.

Starts a throwaway relay, service and state directory from this checkout, builds the Mac (Catalyst) client
with a harness that pairs with them and calls API.download, then compares SHA-256s. Touches no live state:
the harness skips AppState (so the installed client's saved Macs are unchanged) and deletes its keychain items."""
import json, os, shutil, subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/mac-catalyst-download'; out=work/'out'
if work.exists(): shutil.rmtree(work)
out.mkdir(parents=True)
helper=r'''
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,createHash} from 'node:crypto';
import {Store} from './desktop/src/store.mjs';import {createServer,artifactDirectory} from './desktop/src/server.mjs';import {RelayState} from './desktop/src/relay-state.mjs';import {DesktopRelay} from './desktop/src/relay-client.mjs';import {createRelay} from './relay/src/server.mjs';
const relay=createRelay();await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));const endpoint=`ws://127.0.0.1:${relay.server.address().port}`;
const dir=mkdtempSync(join(tmpdir(),'ar-download-'));const store=new Store(dir);const id='claude:download';store.save({id,provider:'claude',control:'managed',status:'idle',updatedAt:Date.now()});
const providers={discover:async()=>({sessions:store.sessions(),warnings:[]}),history:async()=>{},status:()=>{},send:async()=>{}};
const {server}=createServer({store,providers});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const state=new RelayState(store);state.configure(endpoint);const desktop=new DesktopRelay({store,state,apiURL:`http://127.0.0.1:${server.address().port}`});desktop.start();
await new Promise(r=>setTimeout(r,1500));
const bytes=randomBytes(30_000_123);writeFileSync(join(artifactDirectory(store,id),'long.mov'),bytes);
store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run('long',id,'long.mov',join(artifactDirectory(store,id),'long.mov'),'video/quicktime');
console.log(JSON.stringify({code:state.invite().uri,sha:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}));
process.stdin.resume();process.stdin.on('end',async()=>{desktop.close();await relay.close();server.close();store.close();rmSync(dir,{recursive:true,force:true});process.exit(0);});
'''
service=subprocess.Popen(['node','--input-type=module','-e',helper],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
try:
    fixture=json.loads(service.stdout.readline())
    shutil.copytree(root/'ios',work/'ios')
    (work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
import CryptoKit
@main struct AgentRemoteApp: App {
 var body: some Scene { WindowGroup { Text("Download test").task { await run() } } }
 @MainActor func run() async {
  var report = [String: Any]()
  var hostId = ""
  do {
   let invite = try RelayInvite.parse("CODE")
   let (response, secret) = try await EncryptedRelay.pair(invite, name: "download-test")
   hostId = "download-test-" + response.hostId
   try Keychain.put(response.token, host: hostId); try Keychain.put(secret.base64EncodedString(), host: hostId + "/e2e")
   let api = API(host: Host(id: hostId, name: response.name, endpoint: invite.relay, transport: "relay", relayHost: invite.host, deviceId: response.deviceId))
   var updates = 0
   let started = Date()
   let url = try await api.download(Artifact(id: "long", name: "long.mov", mime: "video/quicktime")) { _ in updates += 1 }
   let data = try Data(contentsOf: url)
   report = ["sha": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "size": data.count, "progressUpdates": updates, "seconds": Date().timeIntervalSince(started)]
  } catch { report = ["error": "\\(error)"] }
  for account in [hostId, hostId + "/e2e"] { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "AgentRemote", kSecAttrAccount as String: account] as CFDictionary) }
  try? JSONSerialization.data(withJSONObject: report).write(to: URL(fileURLWithPath: "OUT/report.json"))
  exit(0)
 }
}
'''.replace('CODE',fixture['code']).replace('OUT',str(out)))
    env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
    key=Path.home()/'.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
    auth=['-authenticationKeyPath',str(key),'-authenticationKeyID',os.environ.get('ASC_KEY_ID',''),'-authenticationKeyIssuerID',os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
    subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination','platform=macOS,variant=Mac Catalyst,arch=arm64','-derivedDataPath',work/'derived','-allowProvisioningUpdates',*auth,'build','-quiet'],check=True,env=env,stdout=subprocess.DEVNULL)
    subprocess.run([work/'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'],timeout=180,env=env)
    report=json.loads((out/'report.json').read_text())
    print(json.dumps(report))
    ok=report.get('sha')==fixture['sha'] and report.get('size')==fixture['size']
    print('MATCH' if ok else f"MISMATCH: expected {fixture['size']} bytes sha {fixture['sha']}")
    sys.exit(0 if ok else 1)
finally:
    service.stdin.close(); service.wait(timeout=20)
