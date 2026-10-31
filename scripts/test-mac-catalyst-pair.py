#!/usr/bin/env python3
"""Pair the Mac (Catalyst) client with this Mac's running service through the real relay.

Exercises the Mac keychain, the encrypted relay and the live session list, then
snapshots the window. Revoke the test device afterwards (the script prints how)."""
import os, shutil, subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/mac-catalyst-pair'; out=work/'out'
admin='/Applications/Agent Remote.app/Contents/Resources/service/desktop/src/admin.mjs'
code=subprocess.run(['node',admin,'pair-code'],capture_output=True,text=True,check=True).stdout.strip()
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios');out.mkdir()
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state = AppState()
 var body: some Scene { WindowGroup { SessionListView().environmentObject(state).tint(.mint).preferredColorScheme(.dark).task { await run() } } }
 @MainActor func run() async {
  var report = ""
  do { try await state.pair(code: "CODE"); report += "paired \\(state.host?.name ?? "?") as \\(Platform.deviceName)\\n" } catch { report += "pair failed: \\(error)\\n" }
  report += "keychain token present: \\(state.host.map { Keychain.get($0.id) != nil } ?? false)\\n"
  try? await Task.sleep(for: .seconds(4)); await state.refresh()
  report += "sessions: \\(state.sessions.count), error: \\(state.error ?? "none")\\n"
  report += "host id: \\(state.host?.id ?? "")\\n"
  try? report.write(toFile: "OUT/report.txt", atomically: true, encoding: .utf8)
  try? await Task.sleep(for: .seconds(2))
  if let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first {
   let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
   try? image.pngData()?.write(to: URL(fileURLWithPath: "OUT/live.png"))
  }
  exit(0)
 }
}
'''.replace('CODE',code).replace('OUT',str(out)))
env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
# Xcode's Apple ID session lapses on this Mac; the App Store Connect key lets it create the Mac Catalyst profile
key=Path.home()/'.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
auth=['-authenticationKeyPath',str(key),'-authenticationKeyID',os.environ.get('ASC_KEY_ID',''),'-authenticationKeyIssuerID',os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination','platform=macOS,variant=Mac Catalyst,arch=arm64','-derivedDataPath',work/'derived','-allowProvisioningUpdates',*auth,'build','-quiet'],check=True,env=env)
subprocess.run([work/'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'],timeout=90,env=env)
print((out/'report.txt').read_text() if (out/'report.txt').exists() else 'no report')
print(f'Revoke the test device: node "{admin}" devices, then revoke DEVICE_ID')
