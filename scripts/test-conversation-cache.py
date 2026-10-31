#!/usr/bin/env python3
"""Conversation cache and delta polling, end to end, with the app's own code over a local encrypted relay.

  test-conversation-cache.py [--catalyst] [--old-service] [--real STATE_BACKUP_DIR SESSION_ID] [--simulator UDID] [--relay wss://…]

Starts scripts/conversation-cache-fixture.mjs (relay + service + byte-counting proxy) with a 600-row conversation, or
with a backup copy of a real state.sqlite (read-only for the live service: the copy is what gets opened).

iPhone simulator (default): an XCUITest pairs the real app, opens the chat with no cache (what build 24 always does),
relaunches, reopens it from the cache, then has the "Mac" add a reply and stream another (with a duplicate streamed
copy that is deleted) and checks each appears exactly once. Times and per-phase request bytes go to WORK/summary.json.
--catalyst: an in-process harness on Mac Catalyst times a full fetch, a cache load from disk and delta polls.
--old-service: the service is this repository's HEAD commit (what is running now), to check the fallback.
--relay: register the fixture as a throwaway host on that relay (e.g. production) instead of a local one."""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
args = sys.argv[1:]
root = Path(__file__).resolve().parents[1]
catalyst, old = '--catalyst' in args, '--old-service' in args
real = args[args.index('--real') + 1:args.index('--real') + 3] if '--real' in args else None
udid = args[args.index('--simulator') + 1] if '--simulator' in args else '10AF7DEE-9210-45DE-BB86-B873B11FF10A'
work = root / 'build' / ('conversation-cache-' + ('catalyst' if catalyst else 'sim') + ('-old' if old else '') + ('-real' if real else ''))
if work.exists(): shutil.rmtree(work)
work.mkdir(parents=True); (work / 'triggers').mkdir()
env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
if '--relay' in args: env['RELAY'] = args[args.index('--relay') + 1]

src = root
if old:  # the service as committed at HEAD, i.e. without the delta route
    src = work / 'old-service'; src.mkdir()
    subprocess.run(f'git -C "{root}" archive HEAD desktop relay shared package.json | tar -x -C "{src}"', shell=True, check=True)
    (src / 'node_modules').symlink_to(root / 'node_modules')
state_args = []
if real:
    copy = work / 'state'; copy.mkdir()
    shutil.copy(Path(real[0]) / 'state.sqlite', copy / 'state.sqlite')
    state_args = [str(copy), real[1]]
fixture = subprocess.Popen(['node', root / 'scripts/conversation-cache-fixture.mjs', src, work / 'triggers', *state_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=root, env=env)
try:
    info = json.loads(fixture.stdout.readline())
    marker = '#conversationFiles' if real else 'Final answer 599'
    app = work / 'ios'; shutil.copytree(root / 'ios', app)
    source = app / 'AgentRemote/AgentRemoteApp.swift'
    if catalyst:
        # Only the @main entry point is replaced; the rest of AgentRemoteApp.swift (helpers other code uses) stays.
        original = source.read_text(); assert '@main struct AgentRemoteApp' in original, 'app entry point moved; update this script'
        source.write_text(original.replace('@main struct AgentRemoteApp', 'struct AgentRemoteApp', 1) + r'''
@main struct CacheHarnessApp: App {
 // Unstructured, so presenting the conversation over this view does not cancel the run.
 var body: some Scene { WindowGroup { Text("Cache test").onAppear { guard !Self.started else { return }; Self.started = true; Task { await run() } } } }
 @MainActor static var started = false
 func run() async {
  var report = [String: Any](); var hostID = ""
  do {
   let invite = try RelayInvite.parse("CODE")
   let (response, secret) = try await EncryptedRelay.pair(invite, name: "cache-test")
   hostID = "cache-test-" + response.hostId
   try Keychain.put(response.token, host: hostID); try Keychain.put(secret.base64EncodedString(), host: hostID + "/e2e")
   let api = API(host: Host(id: hostID, name: response.name, endpoint: invite.relay, transport: "relay", relayHost: invite.host, deviceId: response.deviceId))
   let path = API.sessionPath("SESSION")
   func timed(_ query: String) async throws -> (SessionDetail, Int, Double) {
    let started = Date(); let data = try await api.request(path + query)
    let detail = try JSONDecoder().decode(SessionDetail.self, from: data)
    return (detail, data.count, Date().timeIntervalSince(started) * 1000)
   }
   // Build 24 opens a chat with this request and repeats it every second.
   let (full, fullBytes, fullMs) = try await timed("")
   report["fullFetch"] = ["bytes": fullBytes, "ms": fullMs, "rows": full.messages.count]
   var messages = full.messages
   let snapshot = ConversationSnapshot(session: full.session, messages: messages, artifacts: full.artifacts ?? [], cursor: full.cursor, artifactsHash: full.artifactsHash, imagesHash: full.imagesHash, earlierCursor: full.nextBefore, hasOlder: full.nextBefore != nil)
   var started = Date(); LocalCache.storeConversation(snapshot, host: hostID); report["cacheSaveMs"] = Date().timeIntervalSince(started) * 1000
   started = Date(); let loaded = LocalCache.load(ConversationSnapshot.self, host: hostID, key: "conversation:SESSION")
   report["cacheLoadFromDiskMs"] = Date().timeIntervalSince(started) * 1000; report["cachedRows"] = loaded?.messages.count ?? -1
   // Laying the conversation out: the same for a cached open and a fetched one, so the fetch is the difference.
   // Shown as the window's root (this run is an unstructured task, so that does not cancel it). The first pass includes
   // one-time SwiftUI/text warm-up, so the second is the steady cost of opening a cached chat.
   if let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first, let root = window.rootViewController {
    let host = api.host, state = AppState()
    var renders: [Double] = []
    for _ in 0..<2 {
     started = Date()
     let controller = UIHostingController(rootView: NavigationStack { ConversationView(session: full.session, host: host) }.environmentObject(state))
     window.rootViewController = controller; controller.view.layoutIfNeeded()
     renders.append(Date().timeIntervalSince(started) * 1000)
     try await Task.sleep(for: .seconds(2))
     window.rootViewController = root; try await Task.sleep(for: .milliseconds(500))
    }
    report["renderCachedConversationMs"] = renders
   }
   guard let cursor = full.cursor else { report["service"] = "old (no cursor): full page every poll"; throw CancellationError() }
   let query = "?since=\(cursor)&artifacts=\(full.artifactsHash ?? "")&images=\(full.imagesHash ?? "")"
   let (idle, idleBytes, idleMs) = try await timed(query)
   report["idlePoll"] = ["bytes": idleBytes, "ms": idleMs, "delta": idle.delta == true, "rows": idle.messages.count]
   FileManager.default.createFile(atPath: "TRIGGERS/add-1", contents: nil)
   var appeared = false; var cur = idle.cursor ?? cursor; var ah = idle.artifactsHash ?? full.artifactsHash ?? ""; var ih = idle.imagesHash ?? full.imagesHash ?? ""
   for _ in 0..<40 {
    try await Task.sleep(for: .milliseconds(250))
    let (next, bytes, ms) = try await timed("?since=\(cur)&artifacts=\(ah)&images=\(ih)")
    messages = ConversationMerge.apply(messages, next, hasOlder: full.nextBefore != nil)
    cur = next.cursor ?? cur; ah = next.artifactsHash ?? ah; ih = next.imagesHash ?? ih
    if !next.messages.isEmpty { report["newReplyPoll"] = ["bytes": bytes, "ms": ms, "rows": next.messages.count]; appeared = true; break }
   }
   let fresh = try await timed("")
   report["freshReplyAppeared"] = appeared
   report["freshReplyCount"] = messages.filter { $0.text == "Fresh reply 1" }.count
   report["mergedEqualsFullPage"] = Array(messages.suffix(fresh.0.messages.count)).map(\.id) == fresh.0.messages.map(\.id)
  } catch is CancellationError {} catch { report["error"] = "\(error)" }
  for account in [hostID, hostID + "/e2e"] { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "AgentRemote", kSecAttrAccount as String: account] as CFDictionary) }
  LocalCache.clear(host: hostID)
  try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: "WORK/summary.json"))
  exit(0)
 }
}
'''.replace('CODE', info['code']).replace('SESSION', info['session']).replace('TRIGGERS', str(work / 'triggers')).replace('WORK', str(work)))
        key = Path.home() / '.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
        auth = ['-authenticationKeyPath', str(key), '-authenticationKeyID', os.environ.get('ASC_KEY_ID',''), '-authenticationKeyIssuerID', os.environ.get('ASC_ISSUER_ID','')] if key.exists() else []
        subprocess.run(['xcodebuild', '-project', app / 'AgentRemote.xcodeproj', '-scheme', 'AgentRemote', '-destination', 'platform=macOS,variant=Mac Catalyst,arch=arm64', '-derivedDataPath', work / 'derived', '-allowProvisioningUpdates', *auth, 'build', '-quiet'], check=True, env=env, stdout=subprocess.DEVNULL)
        subprocess.run([work / 'derived/Build/Products/Debug-maccatalyst/AgentRemote.app/Contents/MacOS/AgentRemote'], timeout=300, env=env)
        summary = json.loads((work / 'summary.json').read_text())
        print(json.dumps(summary, indent=1))
        ok = 'error' not in summary and (old or (summary.get('freshReplyAppeared') and summary.get('freshReplyCount') == 1 and summary.get('mergedEqualsFullPage') and summary['idlePoll']['delta']))
        print('PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)

    # iPhone simulator: the real app, paired at launch, driven by an XCUITest.
    s = source.read_text()
    anchor = 'SessionListView().environmentObject(state)'
    assert anchor in s
    source.write_text(s.replace(anchor, anchor + '.task { if let code = ProcessInfo.processInfo.environment["PAIR_CODE"], state.hosts.isEmpty { try? await state.pair(code: code) } }', 1))
    tests = app / 'CacheUITests'; tests.mkdir()
    (tests / 'CacheUITests.swift').write_text(r'''import XCTest
final class CacheUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var times: [String: Double] = [:]
    func mark(_ name: String) { FileManager.default.createFile(atPath: env["TRIGGERS"]! + "/" + name, contents: nil) }
    func texts(_ app: XCUIApplication, _ text: String) -> XCUIElementQuery { app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)) }
    func marker(_ app: XCUIApplication) -> XCUIElement {
        let m = env["MARKER"]!
        return m.hasPrefix("#") ? app.descendants(matching: .any)[String(m.dropFirst())] : texts(app, m).firstMatch
    }
    /// Seconds from tapping the chat until its content is on screen.
    func open(_ app: XCUIApplication, _ phase: String) {
        let row = app.staticTexts[env["TITLE"]!]
        var started = Date(); XCTAssertTrue(row.waitForExistence(timeout: 90), "session row"); times[phase + "ListSeconds"] = Date().timeIntervalSince(started)
        mark("phase-" + phase); started = Date(); row.tap()
        XCTAssertTrue(marker(app).waitForExistence(timeout: 90), "conversation content")
        times[phase + "ContentSeconds"] = Date().timeIntervalSince(started)
    }
    func testCacheThenDelta() throws {
        let app = XCUIApplication(); app.launchEnvironment["PAIR_CODE"] = env["PAIR_CODE"]; app.launch()
        open(app, "cold")                                       // no cache: what build 24 does on every open
        sleep(6); mark("phase-idle-cold")                       // let it poll a while
        sleep(10)
        app.navigationBars.buttons.element(boundBy: 0).tap(); sleep(2)    // leaving saves the cache
        app.terminate()
        let again = XCUIApplication(); again.launch()
        open(again, "warm")                                     // from the cache, then deltas
        let warm = XCTAttachment(screenshot: again.screenshot()); warm.name = "reopened-from-cache"; warm.lifetime = .keepAlways; add(warm)
        sleep(6); mark("phase-idle-warm"); sleep(10)
        mark("phase-add"); mark("add-1")
        XCTAssertTrue(texts(again, "Fresh reply 1").firstMatch.waitForExistence(timeout: 20), "new reply appears without a reload")
        XCTAssertEqual(texts(again, "Fresh reply 1").count, 1, "no duplicate")
        mark("stream-1")
        XCTAssertTrue(texts(again, "Streaming reply complete").firstMatch.waitForExistence(timeout: 30))
        sleep(3)
        XCTAssertEqual(texts(again, "Streaming reply").count, 1, "streamed copies collapse into one finished reply")
        if env["MARKER"]!.hasPrefix("#") == false { XCTAssertEqual(texts(again, env["MARKER"]!).count, 1, "no duplicated history") }
        let done = XCTAttachment(screenshot: again.screenshot()); done.name = "after-delta"; done.lifetime = .keepAlways; add(done)
        mark("phase-end")
        try JSONSerialization.data(withJSONObject: times).write(to: URL(fileURLWithPath: env["WORK"]! + "/ui-times.json"))
    }
}
''')
    project = app / 'AgentRemote.xcodeproj/project.pbxproj'; p = project.read_text()
    objects = '''
BBB000000000000000000001 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = CacheUITests/CacheUITests.swift; sourceTree = "<group>"; };
BBB000000000000000000002 = {isa = PBXBuildFile; fileRef = BBB000000000000000000001; };
BBB000000000000000000003 = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = CacheUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
BBB000000000000000000004 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (BBB000000000000000000002); runOnlyForDeploymentPostprocessing = 0; };
BBB000000000000000000005 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
BBB000000000000000000006 = {isa = XCBuildConfiguration; buildSettings = {SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0; PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.agentremote.cacheuitests; GENERATE_INFOPLIST_FILE = YES; TEST_TARGET_NAME = AgentRemote; }; name = Debug; };
BBB000000000000000000007 = {isa = XCConfigurationList; buildConfigurations = (BBB000000000000000000006); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
BBB000000000000000000008 = {isa = PBXContainerItemProxy; containerPortal = 244210E48437B6556980A702; proxyType = 1; remoteGlobalIDString = 34A04005BCAF206EEC990BD9; remoteInfo = AgentRemote; };
BBB000000000000000000009 = {isa = PBXTargetDependency; target = 34A04005BCAF206EEC990BD9; targetProxy = BBB000000000000000000008; };
BBB000000000000000000010 = {isa = PBXNativeTarget; buildConfigurationList = BBB000000000000000000007; buildPhases = (BBB000000000000000000004,BBB000000000000000000005); buildRules = (); dependencies = (BBB000000000000000000009); name = CacheUITests; productName = CacheUITests; productReference = BBB000000000000000000003; productType = "com.apple.product-type.bundle.ui-testing"; };
'''
    targets = 'targets = (\n\t\t\t\t34A04005BCAF206EEC990BD9 /* AgentRemote */,'
    group = 'children = (\n\t\t\t\tF810A3947224DC074E90BB0D /* AgentRemote */,'
    assert targets in p and group in p, 'project.pbxproj layout moved; update this script'
    p = p.replace('objects = {', 'objects = {' + objects, 1).replace(targets, targets + '\n\t\t\t\tBBB000000000000000000010,')
    project.write_text(p.replace(group, 'children = (\n\t\t\t\tBBB000000000000000000001,BBB000000000000000000003,F810A3947224DC074E90BB0D /* AgentRemote */,'))
    schemes = project.parent / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
    ref = lambda i, name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{i}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:AgentRemote.xcodeproj"/>'
    (schemes / 'CacheUI.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="1640" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref('34A04005BCAF206EEC990BD9', 'AgentRemote.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref('BBB000000000000000000010', 'CacheUITests.xctest')}</TestableReference></Testables></TestAction></Scheme>''')
    subprocess.run(['xcrun', 'simctl', 'boot', udid], env=env, stderr=subprocess.DEVNULL)
    subprocess.run(['xcrun', 'simctl', 'uninstall', udid, 'com.agentremote.iphone'], env=env)  # no cache, no saved Macs
    test_env = dict(env, TEST_RUNNER_PAIR_CODE=info['code'], TEST_RUNNER_TITLE=info['title'], TEST_RUNNER_MARKER=marker, TEST_RUNNER_TRIGGERS=str(work / 'triggers'), TEST_RUNNER_WORK=str(work))
    result = subprocess.run(['xcodebuild', '-quiet', '-project', project.parent, '-scheme', 'CacheUI', '-destination', f'platform=iOS Simulator,id={udid}', '-derivedDataPath', work / 'derived', '-resultBundlePath', work / 'results.xcresult', 'CODE_SIGN_IDENTITY=-', 'test'], env=test_env)
    # Per phase: how many conversation requests the app made and how many bytes they carried.
    path = '/sessions/' + info['session'].replace(':', '%3A')
    phases, current = {}, None
    for line in (work / 'triggers/requests.jsonl').read_text().splitlines():
        row = json.loads(line)
        if 'phase' in row: current = row['phase']; phases.setdefault(current, {'requests': 0, 'bytes': 0, 'first': None}); continue
        if current and row['path'].split('?')[0] == path:
            entry = phases[current]; entry['requests'] += 1; entry['bytes'] += row['bytes']; entry['first'] = entry['first'] or row
    times = json.loads((work / 'ui-times.json').read_text()) if (work / 'ui-times.json').exists() else {}
    summary = {'service': 'HEAD (old)' if old else 'working tree (delta)', 'data': 'real copy ' + real[1] if real else 'synthetic 600 rows', 'times': times, 'phases': phases}
    (work / 'summary.json').write_text(json.dumps(summary, indent=1)); print(json.dumps(summary, indent=1))
    print('PASS' if result.returncode == 0 else 'FAIL'); sys.exit(result.returncode)
finally:
    fixture.stdin.close(); fixture.wait(timeout=30)
