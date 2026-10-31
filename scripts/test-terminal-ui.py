#!/usr/bin/env python3
"""Exercise the production phone terminal against a synthetic local PTY frame."""
import os, shutil, subprocess, json, base64, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/terminal-ui'
owner='desktop'; inputs=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  text='\x1b[32mClaude Code — shared terminal\x1b[0m\r\n\r\nChoose a drink:\r\n  1. Tea\r\n> 2. Coffee\r\n\r\nTerminal output stays on this Mac.'
  data=json.dumps(dict(seq=1,reset=True,data=base64.b64encode(text.encode()).decode(),owner=owner,generation=2,ended=False)).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 def do_POST(self):
  global owner
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path.endswith('/control'):owner='you'
  else:inputs.append(base64.b64decode(body['data']))
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(dict(owner=owner,generation=2)).encode())
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios')
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 var body: some Scene { WindowGroup { NavigationStack { TerminalView(session: Session(id:"fixture",provider:"claude",title:"Terminal test",cwd:"/tmp",status:"waiting",updatedAt:0),host:Host(id:"terminal-fixture",name:"Test",endpoint:"http://127.0.0.1:PORT")) }.preferredColorScheme(.dark) } }
}
'''.replace('PORT',str(server.server_port)))
tests=work/'ios/ConversationUITests';tests.mkdir()
(tests/'ConversationUITests.swift').write_text('''import XCTest
final class ConversationUITests: XCTestCase {
 func testTerminalControlAndKeys() {
  let app=XCUIApplication();app.launch()
  XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format:"label CONTAINS %@", "Coffee")).firstMatch.waitForExistence(timeout:15))
  let take=app.buttons["Take control"];XCTAssertTrue(take.waitForExistence(timeout:15));take.tap()
  XCTAssertTrue(app.staticTexts["You have control"].waitForExistence(timeout:5))
  let field=app.textFields["Type into terminal"];XCTAssertTrue(field.waitForExistence(timeout:5));field.tap();field.typeText("Coffee")
  app.buttons["Type"].tap();sleep(1)
  app.buttons["Enter"].tap();sleep(1)
  let shot=XCTAttachment(screenshot:app.screenshot());shot.name="shared-terminal";shot.lifetime = .keepAlways;add(shot)
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

assert any(b'Coffee' in value for value in inputs), inputs
assert b'\r' in inputs, inputs
server.shutdown()
print('Phone terminal takeover, typing and Enter reached the API')
