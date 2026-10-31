#!/usr/bin/env python3
"""Play and save video/audio artifacts with the Mac (Catalyst) client (or, with --simulator, the iPhone app)'s own code over a real (local) encrypted relay.

Starts a throwaway relay, service and state directory from this checkout with a 1080p H.264/AAC mp4 (~12 MB, the size
of the creature-test.mp4 Matthew could not watch) and an mp3 in subfolders, builds the client with a harness that pairs,
lists the session, downloads each file with API.download, presents the real ArtifactPreview and checks that AVKit is
playing it (item ready, clock advancing, video size). It also presents the old Quick Look path for the mp4 and reports
what it contains, and checks ArtifactFiles.saveToDownloads into a scratch folder (never ~/Downloads). Touches no live
state: no AppState, keychain items deleted afterwards."""
import json, os, shutil, subprocess, sys
from pathlib import Path
# Usage: test-mac-catalyst-media.py [--simulator <iOS simulator UDID>]   (default: Mac Catalyst)
simulator=sys.argv[sys.argv.index('--simulator')+1] if '--simulator' in sys.argv else None
root=Path(__file__).resolve().parents[1]; work=root/('build/ios-sim-media' if simulator else 'build/mac-catalyst-media'); out=work/'out'; media=work/'media'
if work.exists(): shutil.rmtree(work)
out.mkdir(parents=True); media.mkdir()
ffmpeg=shutil.which('ffmpeg') or sys.exit('ffmpeg is required (brew install ffmpeg)')
subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','10','-c:v','libx264','-pix_fmt','yuv420p','-b:v','9M','-c:a','aac','-movflags','+faststart',str(media/'creature-test.mp4')],check=True)
subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','sine=frequency=330:sample_rate=44100','-t','6','-c:a','libmp3lame','-b:a','128k',str(media/'vo-test.mp3')],check=True)
helper=r'''
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {Store} from './desktop/src/store.mjs';import {createServer,artifactDirectory,sessionArtifacts} from './desktop/src/server.mjs';import {RelayState} from './desktop/src/relay-state.mjs';import {DesktopRelay} from './desktop/src/relay-client.mjs';import {createRelay} from './relay/src/server.mjs';
const relay=createRelay();await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));const endpoint=`ws://127.0.0.1:${relay.server.address().port}`;
const dir=mkdtempSync(join(tmpdir(),'ar-media-'));const store=new Store(dir);const id='claude:media';store.save({id,provider:'claude',control:'managed',status:'idle',title:'Media',cwd:'/',updatedAt:Date.now()});
const providers={discover:async()=>({sessions:store.sessions(),warnings:[]}),history:async()=>{},status:()=>{},send:async()=>{}};
const {server}=createServer({store,providers});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const state=new RelayState(store);state.configure(endpoint);const desktop=new DesktopRelay({store,state,apiURL:`http://127.0.0.1:${server.address().port}`});desktop.start();
await new Promise(r=>setTimeout(r,1500));
const artifacts=artifactDirectory(store,id);mkdirSync(join(artifacts,'creature'));mkdirSync(join(artifacts,'vo-auditions'));
copyFileSync(process.argv[1],join(artifacts,'creature','creature-test.mp4'));copyFileSync(process.argv[2],join(artifacts,'vo-auditions','vo-test.mp3'));
sessionArtifacts(store,id);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
console.log(JSON.stringify({code:state.invite().uri,session:id,sha:{'creature/creature-test.mp4':sha(process.argv[1]),'vo-auditions/vo-test.mp3':sha(process.argv[2])}}));
process.stdin.resume();process.stdin.on('end',async()=>{desktop.close();await relay.close();server.close();store.close();rmSync(dir,{recursive:true,force:true});process.exit(0);});
'''
service=subprocess.Popen(['node','--input-type=module','-e',helper,str(media/'creature-test.mp4'),str(media/'vo-test.mp3')],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
try:
    fixture=json.loads(service.stdout.readline())
    shutil.copytree(root/'ios',work/'ios')
    (work/'ios/AgentRemote/AgentRemoteApp.swift').write_text(r'''import SwiftUI
import AVKit
import CryptoKit
@MainActor final class Shown: ObservableObject { @Published var file: PreviewFile?; @Published var quickLook: URL? }
@main struct AgentRemoteApp: App {
 @StateObject var shown = Shown()
 var body: some Scene { WindowGroup { Group {
   if let url = shown.quickLook { FileQuickLook(url: url) } else { Text("Media test") }
 }.frame(minWidth: 900, minHeight: 640).sheet(item: $shown.file) { ArtifactPreview(file: $0).modifier(LargeMacSheet()) }.task { await run() } } }
 func controllers(_ root: UIViewController?) -> [UIViewController] {
  guard let root else { return [] }
  return [root] + root.children.flatMap { controllers($0) } + controllers(root.presentedViewController)
 }
 func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap { views($0) } }
 var window: UIWindow? { UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow ?? ($0 as? UIWindowScene)?.windows.first }.first }
 func sha(_ url: URL) -> String { (try? Data(contentsOf: url)).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "" }
 func run() async {
  var report = [String: Any]()
  var hostId = ""
  do {
   let invite = try RelayInvite.parse("CODE")
   let (response, secret) = try await EncryptedRelay.pair(invite, name: "media-test")
   hostId = "media-test-" + response.hostId
   try Keychain.put(response.token, host: hostId); try Keychain.put(secret.base64EncodedString(), host: hostId + "/e2e")
   let api = API(host: Host(id: hostId, name: response.name, endpoint: invite.relay, transport: "relay", relayHost: invite.host, deviceId: response.deviceId))
   let detail = try await api.get(API.sessionPath("SESSION"), as: SessionDetail.self)
   report["listed"] = (detail.artifacts ?? []).map { "\($0.name) \($0.mime)" }
   var files = [String: Any]()
   for artifact in detail.artifacts ?? [] {
    var entry = [String: Any]()
    let started = Date()
    let url = try await api.download(artifact)
    entry["seconds"] = Date().timeIntervalSince(started); entry["sha"] = sha(url); entry["localName"] = url.lastPathComponent
    entry["media"] = MediaKind(name: artifact.name, mime: artifact.mime).map { "\($0)" } ?? "none"
    shown.file = PreviewFile(url: url, name: artifact.name, mime: artifact.mime)
    try await Task.sleep(for: .seconds(4))
    if let view = window?.rootViewController?.presentedViewController?.view ?? window {
     let image = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
     try? image.pngData()?.write(to: URL(fileURLWithPath: "OUT/preview-\((artifact.name as NSString).lastPathComponent).png"))
    }
    if let player = controllers(window?.rootViewController).compactMap({ $0 as? AVPlayerViewController }).first?.player, let item = player.currentItem {
     entry["status"] = item.status == .readyToPlay ? "readyToPlay" : item.status == .failed ? "failed: \(item.error.map { "\($0)" } ?? "")" : "unknown"
     entry["playing"] = player.timeControlStatus == .playing
     entry["currentTime"] = item.currentTime().seconds
     entry["duration"] = item.duration.seconds
     entry["presentationSize"] = [item.presentationSize.width, item.presentationSize.height]
    } else { entry["status"] = "no AVPlayerViewController" }
    shown.file = nil
    try await Task.sleep(for: .milliseconds(500))
    files[artifact.name] = entry
    if artifact.name.hasSuffix(".mp4") {
     // The old path: an embedded QLPreviewController. Record what it actually puts on screen.
     shown.quickLook = url
     try await Task.sleep(for: .seconds(4))
     let ql = controllers(window?.rootViewController).filter { String(describing: type(of: $0)).contains("QL") || String(describing: type(of: $0)).contains("Preview") }
     let classes = Set(ql.flatMap { views($0.view) }.map { String(describing: type(of: $0)) })
     report["quickLookControllers"] = ql.map { String(describing: type(of: $0)) }
     report["quickLookHasPlayer"] = classes.contains { $0.contains("AVPlayer") }
     report["quickLookViewClasses"] = classes.sorted()
     shown.quickLook = nil
     try await Task.sleep(for: .milliseconds(500))
     // Download: two saves must not overwrite each other.
     let scratch = URL(fileURLWithPath: "OUT/downloads")
     try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
     let first = try ArtifactFiles.saveToDownloads(url, folder: scratch), second = try ArtifactFiles.saveToDownloads(url, folder: scratch)
     report["saved"] = [first.lastPathComponent, second.lastPathComponent]
     report["savedSha"] = sha(first)
     report["downloadsFolder"] = (try? FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: false).path) ?? ""
    }
   }
   report["files"] = files
  } catch { report["error"] = "\(error)" }
  for account in [hostId, hostId + "/e2e"] { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "AgentRemote", kSecAttrAccount as String: account] as CFDictionary) }
  try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: "OUT/report.json"))
  exit(0)
 }
}
'''.replace('CODE',fixture['code']).replace('SESSION',fixture['session']).replace('OUT',str(out)))
    env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
    if simulator:
        # Same harness on the iPhone simulator (it reaches the fixture relay on 127.0.0.1 and writes the report to OUT).
        subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination',f'platform=iOS Simulator,id={simulator}','-derivedDataPath',work/'derived','CODE_SIGN_IDENTITY=-','build','-quiet'],check=True,env=env,stdout=subprocess.DEVNULL)
        subprocess.run(['xcrun','simctl','boot',simulator],env=env)
        subprocess.run(['xcrun','simctl','bootstatus',simulator,'-b'],env=env,check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['xcrun','simctl','install',simulator,work/'derived/Build/Products/Debug-iphonesimulator/AgentRemote.app'],env=env,check=True)
        subprocess.run(['xcrun','simctl','launch','--console-pty','--terminate-running-process',simulator,'com.agentremote.iphone'],timeout=240,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    else:
        key=Path.home()/'.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
        auth=['-authenticationKeyPath',str(key),'-authenticationKeyID',os.environ.get('ASC_KEY_ID',''),'-authenticationKeyIssuerID',os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
        subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination','platform=macOS,variant=Mac Catalyst,arch=arm64','-derivedDataPath',work/'derived','-allowProvisioningUpdates',*auth,'build','-quiet'],check=True,env=env,stdout=subprocess.DEVNULL)
        subprocess.run([work/'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'],timeout=240,env=env)
    report=json.loads((out/'report.json').read_text())
    print(json.dumps(report,indent=1))
    failures=[]
    if 'error' in report: failures.append(report['error'])
    files=report.get('files',{})
    for name,sha in fixture['sha'].items():
        entry=files.get(name) or {}
        if entry.get('sha')!=sha: failures.append(f'{name}: downloaded bytes differ')
        if entry.get('status')!='readyToPlay' or not entry.get('playing') or entry.get('currentTime',0)<1: failures.append(f'{name}: not playing ({entry.get("status")}, t={entry.get("currentTime")})')
    if files.get('creature/creature-test.mp4',{}).get('presentationSize')!=[1920,1080]: failures.append('mp4: no 1920x1080 video frame size')
    if report.get('saved')!=['creature-test.mp4','creature-test 2.mp4'] or report.get('savedSha')!=fixture['sha']['creature/creature-test.mp4']: failures.append(f'save to Downloads: {report.get("saved")}')
    print('PASS' if not failures else 'FAIL: '+'; '.join(failures))
    sys.exit(1 if failures else 0)
finally:
    service.stdin.close(); service.wait(timeout=20)
