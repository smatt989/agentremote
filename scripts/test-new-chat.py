#!/usr/bin/env python3
"""New chat opens at once, end to end, with the app's own code over a local encrypted relay.

  test-new-chat.py [--simulator UDID] [--delay MS]

Starts scripts/new-chat-fixture.mjs, whose "Mac" takes --delay ms (default 3000) to make a chat. An XCUITest pairs the
real app on the iPhone simulator, then checks that the new-chat form opens filled in, that Create chat opens the chat
with the composer focused before the Mac has answered, that a message typed and sent meanwhile is delivered once, and
that a failed start is reported and retried by sending again. Times go to WORK/summary.json."""
import json, os, shutil, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(__file__).resolve().parents[1]
udid = args[args.index('--simulator') + 1] if '--simulator' in args else '10AF7DEE-9210-45DE-BB86-B873B11FF10A'
work = root / 'build/new-chat-sim'
if work.exists(): shutil.rmtree(work)
work.mkdir(parents=True)
env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
if '--delay' in args: env['CREATE_DELAY_MS'] = args[args.index('--delay') + 1]
fixture = subprocess.Popen(['node', root / 'scripts/new-chat-fixture.mjs', work], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=root, env=env)
try:
    info = json.loads(fixture.stdout.readline())
    app = work / 'ios'; shutil.copytree(root / 'ios', app, ignore=shutil.ignore_patterns('xcuserdata'))
    source = app / 'AgentRemote/AgentRemoteApp.swift'; s = source.read_text()
    anchor = 'SessionListView().environmentObject(state)'
    assert anchor in s, 'app entry point moved; update this script'
    source.write_text(s.replace(anchor, anchor + '.task { if let code = ProcessInfo.processInfo.environment["PAIR_CODE"], state.hosts.isEmpty { try? await state.pair(code: code) } }', 1))
    tests = app / 'NewChatUITests'; tests.mkdir()
    (tests / 'NewChatUITests.swift').write_text(r'''import XCTest
final class NewChatUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var times: [String: Double] = [:]
    func now() -> Double { Date().timeIntervalSince1970 * 1000 }
    func texts(_ app: XCUIApplication, _ text: String) -> XCUIElementQuery { app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)) }
    func shot(_ app: XCUIApplication, _ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
    func focused(_ element: XCUIElement) -> Bool { (element.value(forKey: "hasKeyboardFocus") as? Bool) == true }
    func testNewChatOpensAtOnce() throws {
        let app = XCUIApplication(); app.launchEnvironment["PAIR_CODE"] = env["PAIR_CODE"]; app.launch()
        let newChat = app.buttons["New chat"], create = app.buttons["Create chat"], composer = app.descendants(matching: .any)["composer"], send = app.buttons["Send message"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 60), "chat list")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: newChat); waitForExpectations(timeout: 60)
        sleep(3) // the list fetches the form's choices in the background
        var started = Date(); newChat.tap()
        XCTAssertTrue(create.waitForExistence(timeout: 30), "form"); times["formFirstOpenSeconds"] = Date().timeIntervalSince(started)
        XCTAssertFalse(texts(app, "Checking").firstMatch.exists, "form waited on the Mac")
        shot(app, "form"); app.buttons["Cancel"].tap(); sleep(1)

        // The chat opens, focused, while the Mac is still making it; a message sent meanwhile is delivered once.
        newChat.tap(); XCTAssertTrue(create.waitForExistence(timeout: 5))
        times["createTappedAt"] = now(); create.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "composer"); times["composerShownAt"] = now()
        started = Date(); while !focused(composer) && Date().timeIntervalSince(started) < 3 { usleep(100_000) }
        XCTAssertTrue(focused(composer), "composer focused without a tap"); times["composerFocusedAt"] = now()
        shot(app, "opened")
        composer.typeText("hello there"); times["typedAt"] = now()
        send.tap(); times["sentAt"] = now()
        XCTAssertTrue(texts(app, "Echo: hello there").firstMatch.waitForExistence(timeout: 30), "reply")
        times["replyAt"] = now(); sleep(2)
        XCTAssertEqual(texts(app, "Echo: hello there").count, 1, "one reply")
        // Inside the transcript: the chat is also titled from its first message.
        let history = app.descendants(matching: .any)["conversationHistory"].staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "hello there"))
        XCTAssertEqual(history.count, 2, "message and reply, once each")
        XCTAssertFalse(texts(app, "Couldn").firstMatch.exists)
        shot(app, "replied")

        // A start the Mac refuses is reported, keeps the message, and sending again retries it.
        app.navigationBars.buttons.element(boundBy: 0).tap(); sleep(1)
        newChat.tap(); XCTAssertTrue(create.waitForExistence(timeout: 5))
        let name = app.textFields["Chat name"]; name.tap(); name.typeText("Fail once")
        create.tap(); XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.typeText("second try"); send.tap()
        XCTAssertTrue(texts(app, "Couldn’t start this chat").firstMatch.waitForExistence(timeout: 30), "failure shown")
        shot(app, "failed")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send); waitForExpectations(timeout: 10)
        send.tap()
        XCTAssertTrue(texts(app, "Echo: second try").firstMatch.waitForExistence(timeout: 30), "retried")
        sleep(2); XCTAssertEqual(texts(app, "Echo: second try").count, 1)
        XCTAssertFalse(texts(app, "Couldn").firstMatch.exists, "error cleared")
        shot(app, "retried")
        app.navigationBars.buttons.element(boundBy: 0).tap(); sleep(7)
        times["listRows"] = Double(app.cells.count)
        shot(app, "list")
        try JSONSerialization.data(withJSONObject: times).write(to: URL(fileURLWithPath: env["WORK"]! + "/ui-times.json"))
    }
}
''')
    project = app / 'AgentRemote.xcodeproj/project.pbxproj'; p = project.read_text()
    objects = '''
BBB000000000000000000001 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = NewChatUITests/NewChatUITests.swift; sourceTree = "<group>"; };
BBB000000000000000000002 = {isa = PBXBuildFile; fileRef = BBB000000000000000000001; };
BBB000000000000000000003 = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = NewChatUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
BBB000000000000000000004 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (BBB000000000000000000002); runOnlyForDeploymentPostprocessing = 0; };
BBB000000000000000000005 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
BBB000000000000000000006 = {isa = XCBuildConfiguration; buildSettings = {SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0; PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.agentremote.newchatuitests; GENERATE_INFOPLIST_FILE = YES; TEST_TARGET_NAME = AgentRemote; }; name = Debug; };
BBB000000000000000000007 = {isa = XCConfigurationList; buildConfigurations = (BBB000000000000000000006); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
BBB000000000000000000008 = {isa = PBXContainerItemProxy; containerPortal = 244210E48437B6556980A702; proxyType = 1; remoteGlobalIDString = 34A04005BCAF206EEC990BD9; remoteInfo = AgentRemote; };
BBB000000000000000000009 = {isa = PBXTargetDependency; target = 34A04005BCAF206EEC990BD9; targetProxy = BBB000000000000000000008; };
BBB000000000000000000010 = {isa = PBXNativeTarget; buildConfigurationList = BBB000000000000000000007; buildPhases = (BBB000000000000000000004,BBB000000000000000000005); buildRules = (); dependencies = (BBB000000000000000000009); name = NewChatUITests; productName = NewChatUITests; productReference = BBB000000000000000000003; productType = "com.apple.product-type.bundle.ui-testing"; };
'''
    targets = 'targets = (\n\t\t\t\t34A04005BCAF206EEC990BD9 /* AgentRemote */,'
    group = 'children = (\n\t\t\t\tF810A3947224DC074E90BB0D /* AgentRemote */,'
    assert targets in p and group in p, 'project.pbxproj layout moved; update this script'
    p = p.replace('objects = {', 'objects = {' + objects, 1).replace(targets, targets + '\n\t\t\t\tBBB000000000000000000010,')
    project.write_text(p.replace(group, 'children = (\n\t\t\t\tBBB000000000000000000001,BBB000000000000000000003,F810A3947224DC074E90BB0D /* AgentRemote */,'))
    schemes = project.parent / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
    ref = lambda i, name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{i}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:AgentRemote.xcodeproj"/>'
    (schemes / 'NewChatUI.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="1640" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref('34A04005BCAF206EEC990BD9', 'AgentRemote.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref('BBB000000000000000000010', 'NewChatUITests.xctest')}</TestableReference></Testables></TestAction></Scheme>''')
    subprocess.run(['xcrun', 'simctl', 'boot', udid], env=env, stderr=subprocess.DEVNULL)
    subprocess.run(['xcrun', 'simctl', 'uninstall', udid, 'com.agentremote.iphone'], env=env)  # no cache, no saved Macs
    test_env = dict(env, TEST_RUNNER_PAIR_CODE=info['code'], TEST_RUNNER_WORK=str(work))
    result = subprocess.run(['xcodebuild', '-quiet', '-project', project.parent, '-scheme', 'NewChatUI', '-destination', f'platform=iOS Simulator,id={udid}', '-derivedDataPath', work / 'derived', '-resultBundlePath', work / 'results.xcresult', 'CODE_SIGN_IDENTITY=-', 'test'], env=test_env)
    times = json.loads((work / 'ui-times.json').read_text()) if (work / 'ui-times.json').exists() else {}
    creates = [json.loads(l) for l in (work / 'requests.jsonl').read_text().splitlines() if '"POST"' in l and '"/sessions"' in l]
    summary = {'createDelayMs': info['delay'], 'times': times, 'creates': creates}
    if times and creates:
        made = creates[0]['done']
        summary['chatOpenedMsAfterTap'] = round(times['composerShownAt'] - times['createTappedAt'])
        summary['typedBeforeMacMadeChat'] = times['typedAt'] < made
        summary['macMadeChatMsAfterTap'] = round(made - times['createTappedAt'])
    ok = result.returncode == 0 and summary.get('chatOpenedMsAfterTap', 1e9) < info['delay'] and len(creates) == 3
    (work / 'summary.json').write_text(json.dumps(summary, indent=1)); print(json.dumps(summary, indent=1))
    print('PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
finally:
    fixture.stdin.close(); fixture.wait(timeout=30)
