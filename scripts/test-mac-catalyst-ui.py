#!/usr/bin/env python3
"""Render the Mac (Catalyst) client against a fixture service and save window snapshots.

The copied app selects a chat at launch and writes PNGs of its own window, so the
desktop layout can be checked without Screen Recording or Accessibility access."""
import os, shutil, subprocess, json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/mac-catalyst-ui'; shots=work/'shots'
now=time.time()*1000
sessions=[dict(id='claude:one',provider='claude',title='Port of Victoria page',cwd='/Users/me/blueenergy',status='idle',control='managed',updatedAt=now,lastCompletedAt=now-60000,lastCompletedRole='assistant',unread=True),
 dict(id='codex:two',provider='codex',title='Relay reconnect bug',cwd='/Users/me/AgentRemote',status='running',control='managed',updatedAt=now,lastCompletedAt=now-3600000,lastCompletedRole='user'),
 dict(id='claude:three',provider='claude',title='Hearing clinic intake rules',cwd='/Users/me',status='ended',control='managed',updatedAt=now,lastCompletedAt=now-86400000,lastCompletedRole='assistant')]
messages=[dict(id='u1',role='user',kind='text',text='Can you tighten the hero copy on the project page?',seq=1,createdAt=now-120000),
 dict(id='a1',role='assistant',kind='text',text='Done. The hero now leads with **capacity and timeline**:\n\n- 250 MW first phase\n- Construction start 2027\n\nI kept the photo crop unchanged.',seq=2,createdAt=now-60000,completedAt=now-60000)]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def respond(self,value):
  data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if self.path=='/settings/models':self.respond(dict(codex='',claude='',local='',localProvider='ollama'))
  elif self.path.startswith('/sessions?') or self.path=='/sessions':self.respond(dict(sessions=sessions,warnings=[]))
  elif self.path.startswith('/sessions/'):self.respond(dict(session=sessions[0],messages=messages,artifacts=[],questions=[]))
  else:self.send_response(404);self.end_headers()
 def do_POST(self):self.respond(dict(session=sessions[0]))
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios');shots.mkdir()
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state: AppState
 init() { let state=AppState();state.hosts=[Host(id:"fixture",name:"Studio Mac",endpoint:"http://127.0.0.1:PORT")];state.selectedHostID="fixture";_state=StateObject(wrappedValue:state) }
 var body: some Scene { WindowGroup { SessionListView().environmentObject(state).tint(.mint).preferredColorScheme(.dark).task { await snapshots() } } }
 @MainActor func snapshots() async {
  for index in 1...4 {
   try? await Task.sleep(for: .seconds(3))
   guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { continue }
   let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
   try? image.pngData()?.write(to: URL(fileURLWithPath: "SHOTS/\\(index).png"))
  }
  exit(0)
 }
}
'''.replace('PORT',str(server.server_port)).replace('SHOTS',str(shots)))
models=work/'ios/AgentRemote/Models.swift';models.write_text(models.read_text().replace('Keychain.get(host.id)','Optional("fixture-token")'))
listing=work/'ios/AgentRemote/SessionListView.swift'
listing.write_text(listing.read_text().replace('@State private var selected: Session?','@State private var selected: Session? = Session(id: "claude:one", provider: "claude", title: "Port of Victoria page", cwd: "/Users/me/blueenergy", status: "idle", updatedAt: 0)'))
env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
# Xcode's Apple ID session lapses on this Mac; the App Store Connect key lets it create the Mac Catalyst profile
key=Path.home()/'.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
auth=['-authenticationKeyPath',str(key),'-authenticationKeyID',os.environ.get('ASC_KEY_ID',''),'-authenticationKeyIssuerID',os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination','platform=macOS,variant=Mac Catalyst,arch=arm64','-derivedDataPath',work/'derived','-allowProvisioningUpdates',*auth,'build','-quiet'],check=True,env=env)
app=work/'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'
subprocess.run([app],timeout=60,env=env)
print('\n'.join(str(p) for p in sorted(shots.glob('*.png'))))
