#!/usr/bin/env python3
"""Send from the Mac (Catalyst) composer while it has focus, with a short and a long prompt.

Return used to set the UITextView non-editable inside a SwiftUI update; resigning first responder there
re-entered the view graph and spun on an AttributeGraph cycle (the 131 s hang of Oct 12, 2026). The app
copy focuses the composer, types, submits, then reports whether the main thread came back.
Usage: test-mac-catalyst-composer.py [lines]   (default runs 1 and 40 lines)"""
import os, shutil, subprocess, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/mac-catalyst-composer'
now=time.time()*1000
session=dict(id='claude:one',provider='claude',title='Composer',cwd='/Users/me',status='idle',control='managed',updatedAt=now)
posted=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def respond(self,value):
  data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if self.path=='/settings/models':self.respond(dict(codex='',claude='',local='',localProvider='ollama'))
  elif self.path.startswith('/sessions?') or self.path=='/sessions':self.respond(dict(sessions=[session],warnings=[]))
  elif self.path.startswith('/sessions/'):self.respond(dict(session=session,messages=[],artifacts=[],questions=[]))
  else:self.send_response(404);self.end_headers()
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('Content-Length') or 0))
  if self.path.endswith('/messages'):posted.append(json.loads(body or b'{}').get('text','')); time.sleep(1)
  self.respond(dict(session=session))
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios')
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state: AppState
 init() { let state=AppState();state.hosts=[Host(id:"fixture",name:"Studio Mac",endpoint:"http://127.0.0.1:PORT")];state.selectedHostID="fixture";_state=StateObject(wrappedValue:state) }
 var body: some Scene { WindowGroup { SessionListView().environmentObject(state).tint(.mint).task { await drive() } } }
 func find(_ view: UIView) -> ReturnSendingTextView? { (view as? ReturnSendingTextView) ?? view.subviews.lazy.compactMap(find).first }
 @MainActor func drive() async {
  try? await Task.sleep(for: .seconds(3))
  let lines = Int(ProcessInfo.processInfo.environment["COMPOSER_LINES"] ?? "40") ?? 40
  guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first, let field = find(window) else { print("RESULT no-composer"); exit(2) }
  field.becomeFirstResponder()
  field.insertText((1...lines).map { "Line \\($0) of a long prompt pasted into the composer." }.joined(separator: "\\n"))
  try? await Task.sleep(for: .milliseconds(500))
  let started = Date()
  field.submit?()
  try? await Task.sleep(for: .milliseconds(100))
  print("RESULT returned \\(String(format: "%.2f", Date().timeIntervalSince(started))) focused=\\(field.isFirstResponder) text=\\(field.text.count)"); fflush(stdout)
  try? await Task.sleep(for: .seconds(2))
  print("RESULT after-send focused=\\(field.isFirstResponder) text=\\(field.text.count)"); fflush(stdout)
  exit(0)
 }
}
'''.replace('PORT',str(server.server_port)))
models=work/'ios/AgentRemote/Models.swift';models.write_text(models.read_text().replace('Keychain.get(host.id)','Optional("fixture-token")'))
listing=work/'ios/AgentRemote/SessionListView.swift'
listing.write_text(listing.read_text().replace('@State private var selected: Session?','@State private var selected: Session? = Session(id: "claude:one", provider: "claude", title: "Composer", cwd: "/Users/me", status: "idle", updatedAt: 0)'))
env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
key=Path.home()/'.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
auth=['-authenticationKeyPath',str(key),'-authenticationKeyID',os.environ.get('ASC_KEY_ID',''),'-authenticationKeyIssuerID',os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination','platform=macOS,variant=Mac Catalyst,arch=arm64','-derivedDataPath',work/'derived','-allowProvisioningUpdates',*auth,'build','-quiet'],check=True,env=env)
app=work/'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'
failed=False
for lines in ([int(sys.argv[1])] if len(sys.argv)>1 else [1,40]):
 posted.clear()
 try:
  out=subprocess.run([app],timeout=30,env=dict(env,COMPOSER_LINES=str(lines)),capture_output=True,text=True)
  results=[l for l in out.stdout.splitlines() if l.startswith('RESULT')]
  cycles=out.stderr.count('cycle detected')
  ok=len(results)==2 and posted and not cycles and 'focused=true' in results[1] and results[1].endswith('text=0')
 except subprocess.TimeoutExpired:
  results=['hung: no answer in 30 s'];cycles='?';ok=False;subprocess.run(['pkill','-f',str(app)])
 failed|=not ok
 print(f"{lines} lines: {'PASS' if ok else 'FAIL'}  posted={len(posted)} cycle-warnings={cycles}  "+' | '.join(results))
sys.exit(1 if failed else 0)
