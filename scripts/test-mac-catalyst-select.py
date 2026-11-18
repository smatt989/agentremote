#!/usr/bin/env python3
"""Check that Mac (Catalyst) chat text selects like a document: render Markdown messages against a fixture
service, select part of a reply in its text view, copy it, and save window snapshots.

SwiftUI's textSelection only copies a whole Text on Catalyst, so messages are UIKit text views on Mac.
`--before` renders the old SwiftUI Text path in the same build, for a side-by-side look."""
import os, shutil, subprocess, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
before='--before' in sys.argv
root=Path(__file__).resolve().parents[1]; work=root/('build/mac-catalyst-select'+('-before' if before else '')); shots=work/'shots'
now=time.time()*1000
sessions=[dict(id='claude:one',provider='claude',title='Port of Victoria page',cwd='/Users/me/blueenergy',status='idle',control='managed',updatedAt=now,lastCompletedAt=now-60000,lastCompletedRole='assistant')]
reply='''## Hero copy

Done. The hero now leads with **capacity and timeline**, in *plain words*, and links to [the permit](https://example.com/permit). The class is `hero-lead`.
A second line in the same paragraph.

- 250 MW first phase
- Construction start 2027
  - nested detail
1. Numbered one
2. Numbered two

> Quoted line one
> Quoted line two

```swift
let capacity = 250 // MW, a deliberately long line so the code block has to scroll sideways on narrow windows
```

| Item | Value | Note |
|---|---|---|
| Phase | 1 | first |

I kept the photo crop unchanged.'''
messages=[dict(id='u1',role='user',kind='text',text='Can you tighten the hero copy on the project page?\nKeep it short.',seq=1,createdAt=now-120000),
 dict(id='a1',role='assistant',kind='text',text=reply,seq=2,createdAt=now-60000,completedAt=now-60000),
 dict(id='s1',role='system',kind='error',text='Codex exited with code 1: rate limited',seq=3,createdAt=now-30000)]
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
shutil.copytree(root/'ios',work/'ios',ignore=shutil.ignore_patterns('build'));shots.mkdir()
appFile=work/'ios/AgentRemote/AgentRemoteApp.swift'
# Keep the real file (it also holds NotificationActions); only its @main moves to the fixture app.
appFile.write_text(appFile.read_text().replace('@main struct AgentRemoteApp: App','struct ShippedAgentRemoteApp: App')+'''
@main struct FixtureApp: App {
 @StateObject private var state: AppState
 init() { let state=AppState();state.hosts=[Host(id:"fixture",name:"Studio Mac",endpoint:"http://127.0.0.1:PORT")];state.selectedHostID="fixture";_state=StateObject(wrappedValue:state) }
 var body: some Scene { WindowGroup { SessionListView().environmentObject(state).tint(.mint).preferredColorScheme(.dark).task { await check() } } }
 @MainActor func check() async {
  try? await Task.sleep(for: .seconds(5))
  func views(_ view: UIView) -> [UITextView] { ((view as? UITextView).map { [$0] } ?? []) + view.subviews.flatMap(views) }
  guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { exit(1) }
  window.windowScene?.sizeRestrictions?.minimumSize = CGSize(width: 1100, height: 900)
  try? await Task.sleep(for: .seconds(1))
  let shot = { (name: String) in
   let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
   try? image.pngData()?.write(to: URL(fileURLWithPath: "SHOTS/" + name + ".png"))
  }
  shot("chat")
  let readOnly = views(window).filter { !$0.isEditable }
  var report = ["textViews=\\(readOnly.count)"]
  for view in readOnly { report.append("view selectable=\\(view.isSelectable) frame=\\(view.frame.integral) text=\\(view.text.prefix(40).debugDescription)") }
  func scrollViews(_ view: UIView) -> [UIScrollView] { ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews) }
  let history = scrollViews(window).filter({ !($0 is UITextView) }).max(by: { $0.contentSize.height < $1.contentSize.height })
  try? await Task.sleep(for: .seconds(2))
  report.append("offset before select=\\(history?.contentOffset.y ?? -1) content=\\(history?.contentSize.height ?? -1) bounds=\\(history?.bounds.height ?? -1)")
  if let prose = readOnly.first(where: { $0.text.contains("capacity") }) {
   let text = prose.text as NSString, start = text.range(of: "capacity").location, end = NSMaxRange(text.range(of: "Construction"))
   prose.becomeFirstResponder()
   prose.selectedRange = NSRange(location: start, length: end - start)
   UIPasteboard.general.string = ""
   prose.copy(nil)
   report.append("copied=" + (UIPasteboard.general.string ?? "nil").debugDescription)
   try? await Task.sleep(for: .seconds(1.5))
   report.append("offset after select=\\(history?.contentOffset.y ?? -1) content=\\(history?.contentSize.height ?? -1)")
   shot("selected")
  } else { report.append("no prose view") }
  if let history = scrollViews(window).filter({ !($0 is UITextView) }).max(by: { $0.contentSize.height < $1.contentSize.height }) {
   history.setContentOffset(.zero, animated: false)
   try? await Task.sleep(for: .seconds(1))
   shot("top")
   if let bubble = views(window).first(where: { !$0.isEditable && $0.text.hasPrefix("Can you") }) { report.append("bubble frame=\\(bubble.frame.integral)") } else { report.append("no bubble view") }
  }
  try? report.joined(separator: "\\n").write(toFile: "SHOTS/report.txt", atomically: true, encoding: .utf8)
  exit(0)
 }
}
'''.replace('PORT',str(server.server_port)).replace('SHOTS',str(shots)))
models=work/'ios/AgentRemote/Models.swift';models.write_text(models.read_text().replace('Keychain.get(host.id)','Optional("fixture-token")'))
listing=work/'ios/AgentRemote/SessionListView.swift'
listing.write_text(listing.read_text().replace('@State private var selected: Session?','@State private var selected: Session? = Session(id: "claude:one", provider: "claude", title: "Port of Victoria page", cwd: "/Users/me/blueenergy", status: "idle", updatedAt: 0)'))
if before:
 parts=work/'ios/AgentRemote/ConversationParts.swift'
 parts.write_text(parts.read_text().replace('if Platform.isMac {\n                ForEach(rendered.macSegments)','if false {\n                ForEach(rendered.macSegments)').replace('            if Platform.isMac {\n                SelectableRichText','            if false {\n                SelectableRichText'))
env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
# Xcode's Apple ID session lapses on this Mac; the App Store Connect key lets it create the Mac Catalyst profile
key=Path.home()/'.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
auth=['-authenticationKeyPath',str(key),'-authenticationKeyID',os.environ.get('ASC_KEY_ID',''),'-authenticationKeyIssuerID',os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
subprocess.run(['xcodebuild','-project',work/'ios/AgentRemote.xcodeproj','-scheme','AgentRemote','-destination','platform=macOS,variant=Mac Catalyst,arch=arm64','-derivedDataPath',work/'derived','-allowProvisioningUpdates',*auth,'build','-quiet'],check=True,env=env)
app=work/'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'
subprocess.run([app],timeout=90,env=env)
print((shots/'report.txt').read_text() if (shots/'report.txt').exists() else 'no report')
