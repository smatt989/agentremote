#!/usr/bin/env python3
"""Exercise the production phone terminal against a synthetic local PTY frame."""
import os, shutil, subprocess, json, base64, threading, time, atexit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/terminal-chat-real-ui'
if work.exists():shutil.rmtree(work)
work.mkdir(parents=True)
config=work/'fixture.json'
fixture=subprocess.Popen(['node',str(root/'scripts/claude-chat-ui-fixture.mjs'),str(config)],cwd=root)
def cleanup():
 fixture.terminate()
 try:fixture.wait(timeout=20)
 except subprocess.TimeoutExpired:fixture.kill()
atexit.register(cleanup)
for _ in range(450):
 if config.exists():break
 if fixture.poll() is not None:raise RuntimeError('Fixture exited')
 time.sleep(.2)
value=json.loads(config.read_text())
shutil.copytree(root/'ios',work/'ios')
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state = AppState()
 var body: some Scene { WindowGroup { NavigationStack { ConversationView(session: Session(id:"FIXTURE_ID",provider:"claude",title:"Terminal test",cwd:"/tmp",status:"idle",updatedAt:0,terminal:true),host:Host(id:"terminal-fixture",name:"Test",endpoint:"http://127.0.0.1:PORT")) }.environmentObject(state).preferredColorScheme(.dark) } }
}
'''.replace('http://127.0.0.1:PORT',value['url']).replace('FIXTURE_TOKEN',value['token']).replace('FIXTURE_ID',value['id']))
models=work/'ios/AgentRemote/Models.swift'
models.write_text(models.read_text().replace('Keychain.get(host.id)', 'Optional('+json.dumps(value['token'])+')'))
tests=work/'ios/ConversationUITests';tests.mkdir()
(tests/'ConversationUITests.swift').write_text('''import XCTest
final class ConversationUITests: XCTestCase {
 func testChatSendsToSharedTerminal() {
  let app=XCUIApplication();app.launch()
  let field=app.textFields["Message your Mac…"]
  XCTAssertTrue(field.waitForExistence(timeout:15));XCTAssertTrue(field.isEnabled)
  field.tap();field.typeText("What was the code word? Reply only with the word. Do not use tools.  ")
  app.buttons["Send message"].tap()
  XCTAssertTrue(app.staticTexts["ORCHARD"].waitForExistence(timeout:60))
  XCTAssertFalse(app.buttons["Take control"].exists)
  let idle=NSPredicate(format:"exists == false")
  expectation(for:idle,evaluatedWith:app.staticTexts["Working on your Mac…"]);waitForExpectations(timeout:15)
  XCTAssertEqual(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@", "What was the code word?")).count,1)
  field.tap();field.typeText("A new draft")
  XCTAssertTrue(app.buttons["Send message"].isEnabled)
  let shot=XCTAttachment(screenshot:app.screenshot());shot.name="shared-terminal-chat";shot.lifetime = .keepAlways;add(shot)
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
p=p.replace('objects = {','objects = {'+objects,1).replace('targets = (34A04005BCAF206EEC990BD9)', 'targets = (34A04005BCAF206EEC990BD9,AAA000000000000000000010)')
p=p.replace('children = (F810A3947224DC074E90BB0D,', 'children = (AAA000000000000000000001,AAA000000000000000000003,F810A3947224DC074E90BB0D,').replace('com.agentremote.personal','com.agentremote.uifixture')
project.write_text(p)
schemes=project.parent/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
ref=lambda id,name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{id}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:AgentRemote.xcodeproj"/>'
(schemes/'ConversationUI.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="1640" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref('34A04005BCAF206EEC990BD9','AgentRemote.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref('AAA000000000000000000010','ConversationUITests.xctest')}</TestableReference></Testables></TestAction></Scheme>''')
env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
subprocess.run(['xcodebuild','-quiet','-project',str(project.parent),'-scheme','ConversationUI','-destination','platform=iOS Simulator,id=BFCD8CF9-A31D-48FC-AF84-91990B5D76AB','-derivedDataPath',str(work/'derived'),'-resultBundlePath',str(work/'results.xcresult'),'CODE_SIGNING_ALLOWED=NO','test'],env=env,check=True)

print('Real Claude replied in the normal native chat screen with context from its desktop turn')
cleanup()
atexit.unregister(cleanup)
config.unlink(missing_ok=True)
