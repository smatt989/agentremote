"""Capture production SwiftUI views with synthetic data in isolated app copies.
No model requests, production state, or real conversation data are used.
"""
import json, os, pathlib, shutil, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[2]
WORK = ROOT / 'build/website-capture'
OUT = ROOT / 'website/assets/screenshots'
ENV = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer', SITE_FIXTURE='1')
WORK.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
def run(args, **kwargs): subprocess.run([str(a) for a in args], env=ENV, check=True, **kwargs)
def swift_json(value): return '#"""\n'+json.dumps(value,ensure_ascii=False)+'\n"""#'
sessions = [dict(id=f'{provider}:demo-{i}',provider=provider,title=title,cwd=f'/Projects/{project}',status=status,control='managed',updatedAt=1788960000000,lastCompletedAt=1788960000000-i*60000,lastCompletedRole='assistant',unread=i!=2) for i,(provider,title,project,status) in enumerate([
('claude','Fix checkout retries','storefront','running'),('codex','Analyze signup drop-off','analytics','running'),('claude','Plan the API migration','platform','idle'),('codex','Review the release checklist','storefront','idle'),('claude','Draft the launch announcement','launch','idle')])]
messages=[dict(id='m1',role='user',kind='text',text='Fix the checkout retry behavior. Use the payment conventions we discussed in the API migration session.',seq=1),dict(id='m2',role='assistant',kind='text',text='I found the payment conventions in your knowledge base. Retries should reuse the original idempotency key, and a timeout should leave the order pending.\n\nI’ll check the handler against those decisions and add a regression test.',seq=2),dict(id='m3',role='user',kind='text',text='Yes. Keep the current API response format too.',seq=3),dict(id='m4',role='assistant',kind='text',text='The retry path was generating a new key each time. I’ve updated it to reuse the original key.\n\n- Response format preserved\n- Regression test added for duplicate requests\n- Checking the timeout case next',seq=4)]
entries=[dict(id=id,topic=id,title=title,summary=summary,parent=None,kind='subject') for id,title,summary in [
('payments','Payments & checkout','Retry behavior, payment states, and API decisions.'),('work','How I work','Review preferences, planning habits, and working agreements.'),('platform','Platform architecture','Service boundaries, migrations, and API conventions.'),('growth','Growth & analytics','Activation metrics, signup funnels, and experiment definitions.')]]
markdown='''# Payments & checkout

Decisions and conventions learned from work on the storefront and payment API.

## Retrying a payment

Reuse the original **idempotency key** when a payment request times out. A retry must not create a second charge. Leave the order pending until the provider confirms the result.

## Keeping the API compatible

Preserve the current response format during the migration. Changes to error codes need a separate review before release.

## Working preferences

Add a regression test for each behavior change. Keep fixes focused and explain any change to the public API.

## Sources

- API migration — sample conversation: “Keep the same idempotency key when retrying a timeout.”
- Checkout retries — sample conversation: “Keep the current API response format too.”
- Review preferences — sample conversation: “Add a regression test for each behavior change.”'''
page=dict(id='payments',title='Payments & checkout',markdown=markdown,related=[dict(id='platform',title='Platform architecture')],updatedAt=1788960000000,revision=1,pending=False)
(WORK/'fixture.json').write_text(json.dumps(dict(sessions=sessions,messages=messages,entries=entries,page=page),indent=2))
# Mac: compile the actual app views with a separate entry point and seeded models.
mac=WORK/'mac'; mac.mkdir(exist_ok=True)
for source in ['macos/AgentRemote/AgentRemote.swift','macos/AgentRemote/MessageMarkdown.swift','macos/KnowledgeBrowser/WikiView.swift']:
    text=(ROOT/source).read_text().replace('@main struct AgentRemoteMac','struct AgentRemoteMac')
    for signature in ['func refresh() async {','func search(_ text: String) async {','func read(_ id: String) async {']:
        text=text.replace(signature,signature+'\n        if ProcessInfo.processInfo.environment["SITE_FIXTURE"] == "1" { return }')
    (mac/pathlib.Path(source).name).write_text(text)
(mac/'Main.swift').write_text('''import AppKit
import SwiftUI
@main struct WebsiteCapture {
 @MainActor static func main() {
  let app = NSApplication.shared; app.setActivationPolicy(.accessory)
  Task { @MainActor in
   do {
    let decoder = JSONDecoder()
    let window = NSWindow(contentRect:NSRect(x:0,y:0,width:1120,height:780),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
    let model = WikiModel()
    model.entries = try decoder.decode([WikiEntry].self,from:Data('''+swift_json(entries)+'''.utf8))
    model.page = try decoder.decode(WikiPage.self,from:Data('''+swift_json(page)+'''.utf8))
    model.selected = "payments"; model.markdown = model.page!.markdown
    window.contentView = NSHostingView(rootView:WikiView(model:model))
    window.title = "Agent Remote — Knowledge"
    window.appearance = NSAppearance(named:.aqua)
    window.center(); window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps:true)
    try await Task.sleep(nanoseconds:2_000_000_000)
    guard let view = window.contentView?.superview, let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { exit(2) }
    view.cacheDisplay(in:view.bounds,to:bitmap)
    let data = bitmap.representation(using:.png,properties:[:])!
    try data.write(to:URL(fileURLWithPath:ProcessInfo.processInfo.environment["SNAPSHOT"]!))
    exit(0)
   } catch { print(error); exit(1) }
  }
  app.run()
 }
}
''')
app=mac/'Capture.app'; (app/'Contents/MacOS').mkdir(parents=True,exist_ok=True); (app/'Contents/Resources').mkdir(exist_ok=True)
(app/'Contents/Info.plist').write_text('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Capture</string><key>CFBundleIdentifier</key><string>com.agentremote.website-capture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
run(['xcrun','swiftc','-swift-version','5','-parse-as-library','-target','arm64-apple-macosx13.0',*mac.glob('*.swift'),'-o',app/'Contents/MacOS/Capture'])
state=WORK/'state'; state.mkdir(exist_ok=True)
for mode in ['knowledge']:
    subprocess.run([str(app/'Contents/MacOS/Capture'),mode],env=dict(ENV,AGENT_REMOTE_WRAPPER_TEST='1',AGENT_REMOTE_STATE=str(state),SNAPSHOT=str(OUT/f'mac-{mode}.png')),check=True,timeout=30)
    print(f'Captured Mac {mode}',flush=True)
# iPhone: isolated simulator-only copy. Production view layout is unchanged.
ios=WORK/'ios'; shutil.copytree(ROOT/'ios',ios,dirs_exist_ok=True)
models=ios/'AgentRemote/Models.swift';text=models.read_text().replace('func refresh() async {','func refresh() async {\n        if ProcessInfo.processInfo.environment["SITE_FIXTURE"] == "1" { return }');models.write_text(text)
views=ios/'AgentRemote/SessionListView.swift';text=views.read_text().replace('private func load() async {','private func load() async {\n        if ProcessInfo.processInfo.environment["SITE_FIXTURE"] == "1" { return }')
text+='''
func websiteKnowledgeFixture(_ host: Host) -> some View {
 var view = KnowledgeView(host:host)
 view._pages = State(initialValue: try! JSONDecoder().decode([KnowledgePreview].self,from:Data('''+swift_json(entries)+'''.utf8)))
 return view
}
'''
# Keep the fixture factory in the same file as private view state.
text=text.replace('func websiteKnowledgeFixture(_ host: Host) -> some View {\n var view = KnowledgeView(host:host)', 'extension KnowledgeView {\n static func websiteFixture(_ host: Host) -> KnowledgeView {\n var view = KnowledgeView(host:host)')
text+='}\nfunc websiteKnowledgeFixture(_ host: Host) -> some View { KnowledgeView.websiteFixture(host) }\n'
views.write_text(text)
(ios/'AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state: AppState
 init() {
  let model = AppState()
  model.hosts = [Host(id:"website-demo",name:"Studio Mac",endpoint:"http://127.0.0.1:1")]
  model.selectedHostID = "website-demo"
  model.sessions = try! JSONDecoder().decode([Session].self,from:Data('''+swift_json(sessions)+'''.utf8))
  _state = StateObject(wrappedValue:model)
 }
 var body: some Scene { WindowGroup {
  Group {
   if ProcessInfo.processInfo.environment["CAPTURE_MODE"] == "knowledge" { websiteKnowledgeFixture(state.host!) }
   else { SessionListView() }
  }.environmentObject(state).tint(.mint).preferredColorScheme(.dark)
 } }
}
''')
project=ios/'AgentRemote.xcodeproj/project.pbxproj';text=project.read_text();import re
text=re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;', 'PRODUCT_BUNDLE_IDENTIFIER = com.agentremote.websitecapture;',text);project.write_text(text)
run(['xcodebuild','-quiet','-project',ios/'AgentRemote.xcodeproj','-scheme','AgentRemote','-sdk','iphonesimulator','-configuration','Debug','-destination','generic/platform=iOS Simulator','-derivedDataPath',WORK/'derived','CODE_SIGNING_ALLOWED=NO','build'])
# A dedicated simulator avoids touching any existing paired app.
device=subprocess.check_output(['xcrun','simctl','create','Agent Remote Website Capture','com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro','com.apple.CoreSimulator.SimRuntime.iOS-18-6'],env=ENV,text=True).strip()
try:
 run(['xcrun','simctl','boot',device]);run(['xcrun','simctl','bootstatus',device,'-b'])
 run(['xcrun','simctl','status_bar',device,'override','--time','9:41','--dataNetwork','wifi','--wifiMode','active','--wifiBars','3','--batteryState','charged','--batteryLevel','100'])
 run(['xcrun','simctl','install',device,WORK/'derived/Build/Products/Debug-iphonesimulator/AgentRemote.app'])
 import time
 for mode in ['sessions','knowledge']:
  subprocess.run(['xcrun','simctl','launch','--terminate-running-process',device,'com.agentremote.websitecapture'],env=dict(ENV,SIMCTL_CHILD_SITE_FIXTURE='1',SIMCTL_CHILD_CAPTURE_MODE=mode),check=True)
  time.sleep(4)
  run(['xcrun','simctl','io',device,'screenshot',OUT/f'iphone-{mode}.png'])
  print(f'Captured iPhone {mode}',flush=True)
finally:
 subprocess.run(['xcrun','simctl','shutdown',device],env=ENV)
 subprocess.run(['xcrun','simctl','delete',device],env=ENV)
