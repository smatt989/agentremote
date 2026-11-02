#!/usr/bin/env python3
"""Capture App Store screenshots from isolated fixture copies of the production iPhone views.

Produces 6.9-inch iPhone (1320x2868) and 13-inch iPad (2064x2752) portrait captures for
the Chats list, a conversation, and the Knowledge wiki. Uses a separate bundle ID, synthetic
sample data, disposable simulators, and no provider requests. Production source is untouched.
"""
import json, os, pathlib, re, shutil, subprocess, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'build/appstore-screenshots'; WORK = OUT / 'work'
ENV = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
DEVICES = [('iphone-6.9', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max'),
           ('ipad-13', 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-16GB')]
MODES = ['sessions', 'conversation', 'question', 'knowledge']
BUNDLE = 'com.agentremote.appstorecapture'
if WORK.exists(): shutil.rmtree(WORK)
WORK.mkdir(parents=True); OUT.mkdir(exist_ok=True)
def run(args, **kw): return subprocess.run([str(a) for a in args], env=ENV, check=True, **kw)
def swift_json(value): return '#"""\n' + json.dumps(value, ensure_ascii=False) + '\n"""#'
now = 1789050000000
sessions = [dict(id=f'{p}:demo-{i}', provider=p, title=t, cwd=f'/Projects/{proj}', status=s, control='managed', updatedAt=now - i * 60000, lastCompletedAt=now - i * 60000, lastCompletedRole='assistant', unread=i in (0, 1)) for i, (p, t, proj, s) in enumerate([
    ('claude', 'Fix checkout retries', 'storefront', 'running'),
    ('codex', 'Analyze signup drop-off', 'analytics', 'running'),
    ('claude', 'Plan the API migration', 'platform', 'idle'),
    ('codex', 'Review the release checklist', 'storefront', 'idle'),
    ('claude', 'Draft the launch announcement', 'launch', 'idle'),
    ('codex', 'Investigate flaky payment tests', 'storefront', 'idle')])]
messages = [
    dict(id='m1', role='user', kind='text', text='Fix the checkout retry behavior. Use the payment conventions we discussed in the API migration session.', seq=1),
    dict(id='m2', role='assistant', kind='text', text='I found the payment conventions in your knowledge base. Retries should reuse the original idempotency key, and a timeout should leave the order pending.\n\nI’ll check the handler against those decisions and add a regression test.', seq=2),
    dict(id='m3', role='user', kind='text', text='Yes. Keep the current API response format too.', seq=3),
    dict(id='m4', role='assistant', kind='text', text='The retry path was generating a new key each time. I’ve updated it to reuse the original key.\n\n- Response format preserved\n- Regression test added for duplicate requests\n- Checking the timeout case next\n\n```swift\nlet key = order.idempotencyKey ?? UUID().uuidString\n```', seq=4)]
question_session = dict(sessions[5], status='waiting')
question_messages = [
    dict(id='q1', role='user', kind='text', text='The payment tests fail about one run in ten. Find out why and fix it.', seq=1),
    dict(id='q2', role='assistant', kind='text', text='The flaky test times out against the sandbox, and the code then cancels the order while the payment may still go through.\n\nBefore I change the timeout handling, one decision:', seq=2)]
entries = [dict(id=i, topic=i, title=t, summary=s, parent=None, kind='subject') for i, t, s in [
    ('payments', 'Payments & checkout', 'Retry behavior, payment states, and API decisions.'),
    ('work', 'How I work', 'Review preferences, planning habits, and working agreements.'),
    ('platform', 'Platform architecture', 'Service boundaries, migrations, and API conventions.'),
    ('growth', 'Growth & analytics', 'Activation metrics, signup funnels, and experiment definitions.')]]
ios = WORK / 'ios'; shutil.copytree(ROOT / 'ios', ios, ignore=shutil.ignore_patterns('xcuserdata'))
fixture_guard = '\n        if ProcessInfo.processInfo.environment["SITE_FIXTURE"] == "1" { return }'
def patch(path, pairs):
    text = path.read_text()
    for old, new in pairs:
        assert old in text, f'{path.name}: missing {old!r}'
        text = text.replace(old, new)
    path.write_text(text)
patch(ios / 'AgentRemote/Models.swift', [('func refresh() async {', 'func refresh() async {' + fixture_guard)])
patch(ios / 'AgentRemote/SessionListView.swift', [('private func load() async {', 'private func load() async {' + fixture_guard)])
views = ios / 'AgentRemote/SessionListView.swift'
views.write_text(views.read_text() + '''
extension KnowledgeView {
 static func captureFixture(_ host: Host) -> KnowledgeView {
  var view = KnowledgeView(host: host)
  view._pages = State(initialValue: try! JSONDecoder().decode([KnowledgePreview].self, from: Data(''' + swift_json(entries) + '''.utf8)))
  return view
 }
}
func captureKnowledgeFixture(_ host: Host) -> some View { KnowledgeView.captureFixture(host) }
''')
conversation = ios / 'AgentRemote/ConversationView.swift'
patch(conversation, [('guard phase == .active else {', 'guard ProcessInfo.processInfo.environment["SITE_FIXTURE"] != "1", phase == .active else {'),
                     ('private func refresh() async {', 'private func refresh() async {' + fixture_guard)])
conversation.write_text(conversation.read_text() + '''
extension ConversationView {
 static func captureFixture(host: Host) -> ConversationView {
  let decoder = JSONDecoder()
  let session = try! decoder.decode(Session.self, from: Data(''' + swift_json(sessions[0]) + '''.utf8))
  var view = ConversationView(session: session, host: host)
  view._messages = State(initialValue: try! decoder.decode([Message].self, from: Data(''' + swift_json(messages) + '''.utf8)))
  return view
 }
 // A question the agent is waiting on, shown as a tap-to-answer card.
 static func questionFixture(host: Host) -> ConversationView {
  let decoder = JSONDecoder()
  let session = try! decoder.decode(Session.self, from: Data(''' + swift_json(question_session) + '''.utf8))
  var view = ConversationView(session: session, host: host)
  view._messages = State(initialValue: try! decoder.decode([Message].self, from: Data(''' + swift_json(question_messages) + '''.utf8)))
  view._questions = State(initialValue: [AgentQuestion(id: "q", questions: [QuestionItem(id: "timeout", title: "When a payment times out, what should happen to the order?", options: [QuestionOption(label: "Leave it pending", description: "Retry later with the same idempotency key."), QuestionOption(label: "Cancel it", description: "Release the inventory and email the customer.")], multiSelect: false)], state: "pending", native: true)])
  return view
 }
}
''')
# Keep AgentRemoteApp.swift (other code uses its helpers); only the @main entry point is replaced.
app_source = ios / 'AgentRemote/AgentRemoteApp.swift'; app_text = app_source.read_text()
assert '@main struct AgentRemoteApp' in app_text, 'app entry point moved; update this script'
app_source.write_text(app_text.replace('@main struct AgentRemoteApp', 'struct AgentRemoteApp', 1) + '''
@main struct CaptureApp: App {
 @StateObject private var state: AppState
 init() {
  let model = AppState()
  model.hosts = [Host(id: "capture-demo", name: "Studio Mac", endpoint: "http://127.0.0.1:1")]
  model.selectedHostID = "capture-demo"
  model.sessions = try! JSONDecoder().decode([Session].self, from: Data(''' + swift_json(sessions) + '''.utf8))
  _state = StateObject(wrappedValue: model)
 }
 var body: some Scene { WindowGroup {
  Group {
   switch ProcessInfo.processInfo.environment["CAPTURE_MODE"] {
   case "knowledge": captureKnowledgeFixture(state.host!)
   case "conversation": NavigationStack { ConversationView.captureFixture(host: state.host!) }
   case "question": NavigationStack { ConversationView.questionFixture(host: state.host!) }
   default: SessionListView()
   }
  }.environmentObject(state).tint(.mint).preferredColorScheme(.dark)
 } }
}
''')
project = ios / 'AgentRemote.xcodeproj/project.pbxproj'
project.write_text(re.sub(r'AGENT_REMOTE_BUNDLE_ID = [^;]+;', f'AGENT_REMOTE_BUNDLE_ID = {BUNDLE};', project.read_text()))  # app and its extension
run(['xcodebuild', '-quiet', '-project', ios / 'AgentRemote.xcodeproj', '-scheme', 'AgentRemote', '-sdk', 'iphonesimulator', '-configuration', 'Release', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', WORK / 'derived', 'CODE_SIGNING_ALLOWED=NO', 'build'])
app = WORK / 'derived/Build/Products/Release-iphonesimulator/AgentRemote.app'
manifest = []
for label, device_type in DEVICES:
    device = subprocess.check_output(['xcrun', 'simctl', 'create', f'App Store Capture {label}', device_type, RUNTIME], env=ENV, text=True).strip()
    try:
        run(['xcrun', 'simctl', 'boot', device]); run(['xcrun', 'simctl', 'bootstatus', device, '-b'])
        run(['xcrun', 'simctl', 'ui', device, 'appearance', 'dark'])
        run(['xcrun', 'simctl', 'status_bar', device, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100'])
        run(['xcrun', 'simctl', 'install', device, app])
        # A fresh simulator shows one-time system banners (e.g. "Ready for Apple Intelligence"); let them pass first.
        subprocess.run(['xcrun', 'simctl', 'launch', device, BUNDLE], env=dict(ENV, SIMCTL_CHILD_SITE_FIXTURE='1'), check=True); time.sleep(25)
        for mode in MODES:
            subprocess.run(['xcrun', 'simctl', 'launch', '--terminate-running-process', device, BUNDLE], env=dict(ENV, SIMCTL_CHILD_SITE_FIXTURE='1', SIMCTL_CHILD_CAPTURE_MODE=mode), check=True)
            time.sleep(5)
            target = OUT / f'{label}-{mode}.png'
            run(['xcrun', 'simctl', 'io', device, 'screenshot', target])
            size = subprocess.check_output(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', target], text=True)
            w, h = [int(x.split(':')[-1]) for x in size.strip().splitlines()[1:]]
            manifest.append(dict(file=target.name, device=label, mode=mode, width=w, height=h))
            print(f'Captured {label} {mode} {w}x{h}', flush=True)
    finally:
        subprocess.run(['xcrun', 'simctl', 'shutdown', device], env=ENV)
        subprocess.run(['xcrun', 'simctl', 'delete', device], env=ENV)
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Done')
