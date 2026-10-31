#!/usr/bin/env python3
"""Build a simulator-only copy with synthetic history; exercise the actual chat views."""
import os, shutil, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/conversation-ui'
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios')
source=work/'ios/AgentRemote/ConversationView.swift'
guard_line='guard phase == .active else { voice.stop(); composerFocused = false; saveCache(force: true); return }'
s=source.read_text();assert guard_line in s,'ConversationView refresh guard changed; update this fixture'
s=s.replace(guard_line,'guard ProcessInfo.processInfo.environment["UI_FIXTURE"] != "1", phase == .active else { voice.stop(); composerFocused = false; saveCache(force: true); return }')
s+='''
extension ConversationView {
    static func fixture() -> ConversationView {
        var view = ConversationView(session: Session(id: "fixture", provider: "claude", title: "Conversation test", cwd: "/tmp", status: "running", updatedAt: 0), host: Host(id: "fixture", name: "Mac", endpoint: "http://127.0.0.1:1"))
        var rows = (0..<50).map { Message(id: "m\\($0)", role: $0 % 2 == 0 ? "user" : "assistant", kind: "text", text: "Message \\($0)\\n\\nA moderately long fixture paragraph that makes this conversation scroll. It contains **bold text**, `inline code`, and a second line for wrapping on an iPhone.", seq: $0) }
        rows.append(Message(id: "format", role: "assistant", kind: "text", text: "## Retention analysis\\n\\n- Customer retention\\n- Revenue retention\\n\\n```sql\\nSELECT account_id, COUNT(*)\\nFROM completed_jobs\\nGROUP BY account_id;\\n```\\n\\n| Metric | Window |\\n| --- | --- |\\n| Active accounts | 28 days |\\n\\n```swift\\n// Weekly retention\\nlet weeks = try await load(\\"jobs\\", limit: 12)\\nreturn weeks.map { $0.active * 100 }\\n```", seq: 51))
        rows.append(Message(id: "tool1", role: "tool", kind: "Running command", text: "ls -la fixture-tool-output", seq: 52))
        rows.append(Message(id: "tool2", role: "tool", kind: "Tool result", text: "fixture-tool-output", seq: 53))
        rows.append(Message(id: "status1", role: "system", kind: "status", text: "Compacting context", seq: 54))
        rows.append(Message(id: "error1", role: "system", kind: "error", text: "Fixture error stays visible", seq: 55))
        rows.append(Message(id: "latest", role: "assistant", kind: "text", text: "Latest fixture answer", seq: 56))
        // Sent while the agent works: queued, shown last with Cancel (C-3).
        rows.append(Message(id: "queued1", role: "user", kind: "text", text: "Also chart weekly retention", seq: 57, queued: true))
        view._messages = State(initialValue: rows)
        // One file from the latest reply (a chip under it) and one upload without a reply (the list at the end).
        view._artifacts = State(initialValue: [Artifact(id: "file1", name: "retention-by-week.csv", mime: "text/csv", messageId: "latest", size: 48213), Artifact(id: "file2", name: "upload.png", mime: "image/png")])
        if ProcessInfo.processInfo.environment["UI_QUESTIONS"] == "1" {
            view._questions = State(initialValue: [AgentQuestion(id: "q", questions: [QuestionItem(id: "metric", title: "Which retention measure?", options: [QuestionOption(label: "Customer retention", description: "Retained customers"), QuestionOption(label: "Revenue retention", description: "Retained revenue")], multiSelect: false)], state: "pending", native: true, readOnly: false)])
        }
        return view
    }
}
'''
# The fixture app replaces only the @main entry point; the rest of AgentRemoteApp.swift (helpers other code uses) stays.
app_source=work/'ios/AgentRemote/AgentRemoteApp.swift';a=app_source.read_text();assert '@main struct AgentRemoteApp' in a,'app entry point moved; update this fixture'
app_source.write_text(a.replace('@main struct AgentRemoteApp','struct AgentRemoteApp',1))
source.write_text(s+'''
@main struct ConversationFixtureApp: App {
    @StateObject private var state = AppState()
    init() { if ProcessInfo.processInfo.environment["UI_FIXTURE"] == "1" { UserDefaults.standard.removeObject(forKey: "showToolActivity") } }
    var body: some Scene { WindowGroup { NavigationStack { ConversationView.fixture() }.environmentObject(state).tint(.mint).preferredColorScheme(.dark) } }
}
''')
tests=work/'ios/ConversationUITests';tests.mkdir()
(tests/'ConversationUITests.swift').write_text('''import XCTest
final class ConversationUITests: XCTestCase {
    override func setUp() { XCUIDevice.shared.orientation = .portrait }
    func gone(_ element: XCUIElement, _ timeout: TimeInterval = 5) -> Bool {
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)], timeout: timeout) == .completed
    }
    func noKeyboard(_ app: XCUIApplication) -> Bool { gone(app.keyboards.firstMatch) }
    func testJumpToLatestAndFormatting() {
        let app=XCUIApplication();app.launchEnvironment["UI_FIXTURE"]="1";app.launch()
        let jump=app.buttons["jumpToBottom"]
        let latest=app.staticTexts["Latest fixture answer"];XCTAssertTrue(latest.waitForExistence(timeout: 15));XCTAssertTrue(latest.isHittable,"opens at the latest message")
        for _ in 0..<4 { app.scrollViews.firstMatch.swipeDown() }
        XCTAssertFalse(latest.isHittable)
        XCTAssertTrue(jump.waitForExistence(timeout:5));jump.tap();XCTAssertTrue(latest.isHittable)
        XCTAssertTrue(app.otherElements["turnActivity"].exists || app.staticTexts["Working on your Mac…"].exists)
        let shot=XCTAttachment(screenshot: app.screenshot());shot.name="chat-markdown-and-latest";shot.lifetime = .keepAlways;add(shot)
    }
    func testToolActivityToggle() {
        let app=XCUIApplication();app.launchEnvironment["UI_FIXTURE"]="1";app.launch()
        XCTAssertTrue(app.staticTexts["Latest fixture answer"].waitForExistence(timeout:15))
        // Default: tool calls, results and status notes collapse into one marker; errors and replies stay.
        let marker=app.buttons.matching(NSPredicate(format:"label CONTAINS %@","3 tool steps hidden")).firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout:5))
        XCTAssertFalse(app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","Running command")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Fixture error stays visible"].exists);XCTAssertTrue(app.staticTexts["Latest fixture answer"].exists)
        let hidden=XCTAttachment(screenshot:app.screenshot());hidden.name="tool-activity-hidden";hidden.lifetime = .keepAlways;add(hidden)
        let toggle=app.buttons["toggleToolActivity"];XCTAssertTrue(toggle.exists);XCTAssertEqual(toggle.label,"Show tool activity");toggle.tap()
        XCTAssertTrue(app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","Running command")).firstMatch.waitForExistence(timeout:5))
        XCTAssertFalse(marker.exists);XCTAssertEqual(toggle.label,"Hide tool activity")
        let shown=XCTAttachment(screenshot:app.screenshot());shown.name="tool-activity-shown";shown.lifetime = .keepAlways;add(shown)
        // The choice persists across launches.
        app.terminate();app.launchEnvironment["UI_FIXTURE"]="0";app.launch()
        XCTAssertEqual(app.buttons["toggleToolActivity"].label,"Hide tool activity")
        app.buttons["toggleToolActivity"].tap();XCTAssertEqual(app.buttons["toggleToolActivity"].label,"Show tool activity")
    }
    func testKeyboardDismissal() {
        let app=XCUIApplication();app.launchEnvironment["UI_FIXTURE"]="1";app.launch()
        let composer=app.descendants(matching:.any)["composer"];XCTAssertTrue(composer.waitForExistence(timeout:15))
        XCTAssertFalse(app.buttons["hideKeyboard"].exists,"the composer must not focus itself")
        composer.tap()
        let hide=app.buttons["hideKeyboard"];XCTAssertTrue(hide.waitForExistence(timeout:5))
        let open=XCTAttachment(screenshot:app.screenshot());open.name="keyboard-open";open.lifetime = .keepAlways;add(open)
        hide.tap()
        XCTAssertTrue(gone(hide));XCTAssertTrue(noKeyboard(app))
        composer.tap();XCTAssertTrue(hide.waitForExistence(timeout:5),"tapping the composer brings the keyboard back")
        if app.keyboards.count > 0 {
            // A software keyboard is up: dragging the transcript down dismisses it interactively.
            let history=app.scrollViews["conversationHistory"]
            history.coordinate(withNormalizedOffset: CGVector(dx:0.5,dy:0.3)).press(forDuration:0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx:0.5,dy:0.97)))
            XCTAssertTrue(gone(hide));XCTAssertTrue(noKeyboard(app))
        }
        let closed=XCTAttachment(screenshot:app.screenshot());closed.name="keyboard-closed";closed.lifetime = .keepAlways;add(closed)
    }
    func save(_ app: XCUIApplication, _ name: String) {
        let shot = app.screenshot()
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/p3-conv-" + name + ".png"))
        let attachment = XCTAttachment(screenshot: shot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testQueueStopFilesAndCode() {
        let app=XCUIApplication();app.launchEnvironment["UI_FIXTURE"]="1";app.launch()
        XCTAssertTrue(app.staticTexts["Latest fixture answer"].waitForExistence(timeout:15))
        XCTAssertTrue(app.descendants(matching:.any)["queuedMessage"].waitForExistence(timeout:5), "queued message shows its status line")
        XCTAssertTrue(app.buttons["cancelQueued"].exists)
        XCTAssertTrue(app.staticTexts["Also chart weekly retention"].exists)
        XCTAssertTrue(app.buttons["stopTurn"].exists, "an empty composer while the agent works offers Stop")
        XCTAssertFalse(app.buttons["Send message"].exists)
        XCTAssertTrue(app.buttons["fileChip"].exists, "the reply's file is a chip under it")
        XCTAssertTrue(app.descendants(matching:.any)["conversationFiles"].exists, "a file with no reply stays in the list at the end")
        XCTAssertFalse(app.staticTexts["YOU"].exists); XCTAssertFalse(app.staticTexts["AGENT"].exists)
        save(app, "bubbles-queued-file")
        let composer=app.descendants(matching:.any)["composer"];composer.tap();composer.typeText("Next step")
        let send=app.buttons["Send message"];XCTAssertTrue(send.waitForExistence(timeout:5));XCTAssertTrue(send.isEnabled,"typing while the agent works queues instead of disabling Send")
        XCTAssertFalse(app.buttons["stopTurn"].exists)
        app.buttons["hideKeyboard"].tap()
        // One short drag up the transcript brings the SQL and Swift blocks of the formatted reply into view.
        let history=app.scrollViews["conversationHistory"]
        history.coordinate(withNormalizedOffset: CGVector(dx:0.5,dy:0.25)).press(forDuration:0.05, thenDragTo: history.coordinate(withNormalizedOffset: CGVector(dx:0.5,dy:0.6)))
        sleep(1)
        XCTAssertTrue(app.staticTexts["swift"].exists || app.staticTexts["sql"].exists, "code blocks show their language")
        save(app, "code-block")
        app.buttons["chatFilesButton"].tap()
        XCTAssertTrue(app.staticTexts["retention-by-week.csv"].waitForExistence(timeout:5));save(app, "files-sheet")
        app.buttons["Done"].tap()
        // Landscape (iPhone): the composer and Send stay reachable. XCUITest screenshots of a landscape app come out
        // rotated and clipped on the iOS 18 simulator, so take that picture with `simctl io … screenshot` instead.
        XCUIDevice.shared.orientation = .landscapeLeft; sleep(2)
        if app.buttons["jumpToBottom"].exists { app.buttons["jumpToBottom"].tap(); sleep(1) }
        XCTAssertTrue(app.buttons["Send message"].isHittable, "composer stays usable in landscape")
        XCTAssertTrue(app.staticTexts["Also chart weekly retention"].exists)
        XCUIDevice.shared.orientation = .portrait
    }
    func testQuestionChoices() {
        let app=XCUIApplication();app.launchEnvironment["UI_FIXTURE"]="1";app.launchEnvironment["UI_QUESTIONS"]="1";app.launch()
        XCTAssertTrue(app.staticTexts["Latest fixture answer"].waitForExistence(timeout:15))
        let button=app.buttons.matching(NSPredicate(format:"label CONTAINS %@", "Revenue retention")).firstMatch
        XCTAssertTrue(button.waitForExistence(timeout:5));button.tap()
        XCTAssertTrue(app.buttons["Continue"].isEnabled)
        XCTAssertTrue(app.descendants(matching:.any)["composer"].placeholderValue?.contains("queue") == true, "a pending question explains that typing queues")
        let shot=XCTAttachment(screenshot:app.screenshot());shot.name="question-choice";shot.lifetime = .keepAlways;add(shot)
    }
}
''')
project=work/'ios/AgentRemote.xcodeproj/project.pbxproj';p=project.read_text()
objects='''
AAA000000000000000000001 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ConversationUITests/ConversationUITests.swift; sourceTree = "<group>"; };
AAA000000000000000000002 = {isa = PBXBuildFile; fileRef = AAA000000000000000000001; };
AAA000000000000000000003 = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = ConversationUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
AAA000000000000000000004 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (AAA000000000000000000002); runOnlyForDeploymentPostprocessing = 0; };
AAA000000000000000000005 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
AAA000000000000000000006 = {isa = XCBuildConfiguration; buildSettings = {SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0; PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.agentremote.uitests; GENERATE_INFOPLIST_FILE = YES; TEST_TARGET_NAME = AgentRemote; CODE_SIGNING_ALLOWED = NO; }; name = Debug; };
AAA000000000000000000007 = {isa = XCConfigurationList; buildConfigurations = (AAA000000000000000000006); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
AAA000000000000000000008 = {isa = PBXContainerItemProxy; containerPortal = 244210E48437B6556980A702; proxyType = 1; remoteGlobalIDString = 34A04005BCAF206EEC990BD9; remoteInfo = AgentRemote; };
AAA000000000000000000009 = {isa = PBXTargetDependency; target = 34A04005BCAF206EEC990BD9; targetProxy = AAA000000000000000000008; };
AAA000000000000000000010 = {isa = PBXNativeTarget; buildConfigurationList = AAA000000000000000000007; buildPhases = (AAA000000000000000000004,AAA000000000000000000005); buildRules = (); dependencies = (AAA000000000000000000009); name = ConversationUITests; productName = ConversationUITests; productReference = AAA000000000000000000003; productType = "com.apple.product-type.bundle.ui-testing"; };
'''
# The project file is multi-line (hand-edited for Mac Catalyst); anchor on its current layout and fail loudly if it moves.
anchors={'targets':'targets = (\n\t\t\t\t34A04005BCAF206EEC990BD9 /* AgentRemote */,','group':'children = (\n\t\t\t\tF810A3947224DC074E90BB0D /* AgentRemote */,'}
for name,anchor in anchors.items(): assert anchor in p,f'project.pbxproj {name} anchor moved; update this script'
p=p.replace('objects = {','objects = {'+objects,1).replace(anchors['targets'],anchors['targets']+'\n\t\t\t\tAAA000000000000000000010,')
p=p.replace(anchors['group'],'children = (\n\t\t\t\tAAA000000000000000000001,AAA000000000000000000003,F810A3947224DC074E90BB0D /* AgentRemote */,').replace('com.agentremote.personal','com.agentremote.uifixture')
project.write_text(p)
schemes=project.parent/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
ref=lambda id,name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{id}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:AgentRemote.xcodeproj"/>'
(schemes/'ConversationUI.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="1640" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref('34A04005BCAF206EEC990BD9','AgentRemote.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref('AAA000000000000000000010','ConversationUITests.xctest')}</TestableReference></Testables></TestAction></Scheme>''')
env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
subprocess.run(['xcodebuild','-quiet','-project',str(project.parent),'-scheme','ConversationUI','-destination',os.environ.get('SIMULATOR','platform=iOS Simulator,name=iPhone 16 Pro,OS=18.6'),'-derivedDataPath',str(work/'derived'),'-resultBundlePath',str(work/'results.xcresult'),'CODE_SIGNING_ALLOWED=NO','test'],env=env,check=True)
