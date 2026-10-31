#!/usr/bin/env python3
"""Exercise the production phone terminal against a synthetic local PTY frame."""
import os, shutil, subprocess, json, base64, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1]; work=root/'build/session-flow-ui'
created=False; posted=False; replied=False; send_id=None
session=dict(id='fixture',provider='codex',title='Fresh session',cwd='/tmp',status='idle',updatedAt=0,control='managed')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/settings/models':value=dict(codex='',claude='',local='',localProvider='ollama')
  elif self.path=='/sessions':value=dict(sessions=[session] if created else [],warnings=[])
  else:
   messages=[]
   if replied:messages=[dict(id='ack',role='user',kind='text',text='Coffee',requestId=send_id,seq=1),dict(id='reply',role='assistant',kind='text',text='\n\n'.join(['Reply paragraph '+str(i)+' with enough text to fill the conversation history.' for i in range(45)])+'\n\nPHONE_REPLY_RECEIVED',seq=2)]
   value=dict(session=session,messages=messages,artifacts=[],questions=[])
  self.respond(value)
 def respond(self,value):
  data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 def do_POST(self):
  global created,posted,replied,send_id
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path=='/sessions':created=True;self.respond(session)
  else:
   assert body['text']=='Coffee  ';posted=True;send_id=body['requestId']
   import time;time.sleep(4)
   replied=True;self.respond({})
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios')
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state: AppState
 init() { let state=AppState();state.hosts=[Host(id:"fixture",name:"Test Mac",endpoint:"http://127.0.0.1:PORT")];state.selectedHostID="fixture";_state=StateObject(wrappedValue:state) }
 var body: some Scene { WindowGroup { SessionListView().environmentObject(state).preferredColorScheme(.dark) } }
}
'''.replace('PORT',str(server.server_port)))
models=work/'ios/AgentRemote/Models.swift';models.write_text(models.read_text().replace('Keychain.get(host.id)','Optional("fixture-token")'))
tests=work/'ios/ConversationUITests';tests.mkdir()
(tests/'ConversationUITests.swift').write_text('''import XCTest
final class ConversationUITests: XCTestCase {
 func testCreateOpensChatAndSendAppearsImmediately() {
  let app=XCUIApplication();app.launch()
  let create=app.buttons["New session"];XCTAssertTrue(create.waitForExistence(timeout:15));create.tap()
  let submit=app.buttons["Create session"];XCTAssertTrue(submit.waitForExistence(timeout:10));submit.tap()
  let field=app.textFields["Message your Mac…"];XCTAssertTrue(field.waitForExistence(timeout:15))
  XCTAssertFalse(app.buttons["jumpToBottom"].exists)
  field.tap();field.typeText("Coffee  ");app.buttons["Send message"].tap()
  XCTAssertTrue(app.staticTexts["Sending…"].waitForExistence(timeout:2))
  XCTAssertTrue(app.staticTexts["Sending…"].exists)
  XCTAssertTrue(app.staticTexts["PHONE_REPLY_RECEIVED"].waitForExistence(timeout:20))
  let bottom=app.staticTexts["PHONE_REPLY_RECEIVED"]
  XCTAssertTrue(bottom.isHittable)
  XCTAssertFalse(app.staticTexts["Working on your Mac…"].exists)
  XCTAssertEqual(app.staticTexts.matching(identifier:"Coffee").count,1)
  XCTAssertFalse(app.buttons["jumpToBottom"].exists)
  let history=app.scrollViews["conversationHistory"]
  history.swipeDown();history.swipeDown()
  let jump=app.buttons["jumpToBottom"];XCTAssertTrue(jump.waitForExistence(timeout:5));jump.tap()
  let hidden=NSPredicate(format:"exists == false");expectation(for:hidden,evaluatedWith:jump);waitForExpectations(timeout:5)
  XCTAssertTrue(bottom.isHittable)
  let shot=XCTAttachment(screenshot:app.screenshot());shot.name="new-session-auto-open";shot.lifetime = .keepAlways;add(shot)
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

assert created and posted and replied
server.shutdown()
print('New session opens conversation, optimistic send renders before delayed acknowledgement, and acknowledgement does not duplicate the message: passed')
