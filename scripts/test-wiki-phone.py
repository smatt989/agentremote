#!/usr/bin/env python3
"""Exercise the actual iPhone chat layout and wiki reader using synthetic, local-only evidence."""
import os, shutil, subprocess, json, threading, re, urllib.parse
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1];work=root/'build/wiki-phone-ui';env=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
entries=[dict(id='work/example~1',title='Example',summary='Company overview.',parent=None),dict(id='work/example/analytics~1',title='Example analytics',summary='Definitions and tools.',parent='work/example~1')]
articles=['# Example\n\nRead the [analytics guide](agentremote-wiki://article?id=work%2Fexample%2Fanalytics~1) to understand the data.\n\n## Related pages\n\n## Sources\n\n1. User stated: Example has an analytics workspace.','# Example analytics\n\nRevenue is measured per billing account.\n\n## Definitions\n\nRefunds are excluded. [source 1]\n\n## Related pages\n\n## Sources\n\n1. User stated: Revenue excludes refunds.']
sessions=[dict(id='layout-'+str(i),provider='codex' if i%2==0 else 'claude',title=title,cwd='/Users/example' if i<3 else '/Users/example/development/ExampleProject',status='running' if i==2 else 'waiting' if i==3 else 'idle',updatedAt=0,lastCompletedAt=1789009200000,latestAssistantMessageId='reply-'+str(i),unread=i==1,control='managed') for i,title in enumerate(['Discuss knowledge base organization','Build a practical app landing page','Update the phone app','Review a longer project conversation with enough words to wrap naturally','Explore hearing aid intake regulations','Plan the next research steps'])]
requests=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  u=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(u.query);offset=int(q.get('offset',['0'])[0]);requests.append(self.path)
  if u.path=='/sessions':value=dict(sessions=sessions,warnings=[])
  elif u.path.startswith('/sessions/'):
   session=next((s for s in sessions if s['id']==u.path.split('/')[2]),sessions[0]);value=dict(session=session,messages=[],artifacts=[],questions=[])
  elif u.path=='/settings/models':value=dict(codex='',claude='',local='',localProvider='ollama')
  elif u.path=='/knowledge':value=dict(results=entries[offset:offset+1])
  elif u.path=='/knowledge/page':
   id=q['id'][0];i=next(i for i,p in enumerate(entries) if p['id']==id);text=articles[i]
   value=dict(page=dict(id=id,title=entries[i]['title'],markdown=text[offset:offset+120],nextOffset=offset+120 if offset+120<len(text) else None,related=[],children=[],backlinks=[],breadcrumbs=[dict(id=entries[0]['id'],title='Example')] if i else [],revision=1,pending=False,updatedAt=1788984000000))
  else:value={}
  data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
if work.exists():shutil.rmtree(work)
shutil.copytree(root/'ios',work/'ios')
(work/'ios/AgentRemote/AgentRemoteApp.swift').write_text('''import SwiftUI
@main struct AgentRemoteApp: App {
 @StateObject private var state: AppState
 init() { let state=AppState();state.hosts=[Host(id:"wiki-fixture",name:"Test Mac",endpoint:"http://127.0.0.1:PORT")];state.selectedHostID="wiki-fixture";_state=StateObject(wrappedValue:state) }
 var body: some Scene { WindowGroup { SessionListView().environmentObject(state).tint(.mint).preferredColorScheme(.dark) } }
}
'''.replace('PORT',str(server.server_port)))
p=work/'ios/AgentRemote/Models.swift';p.write_text(p.read_text().replace('Keychain.get(host.id)','Optional("fixture-token")'))
tests=work/'ios/ConversationUITests';tests.mkdir()
(tests/'ConversationUITests.swift').write_text('''import XCTest
final class ConversationUITests: XCTestCase {
 func capture(_ app: XCUIApplication, _ name: String) {
  let shot=XCTAttachment(screenshot:app.screenshot());shot.name=name;shot.lifetime = .keepAlways;add(shot)
 }
 func testChatLayoutAndSearch() {
  let app=XCUIApplication();app.launch()
  let first=app.buttons["session-layout-0"];XCTAssertTrue(first.waitForExistence(timeout:20))
  let second=app.buttons["session-layout-1"]
  let search=app.textFields["list-search"]
  XCTAssertTrue(search.exists)
  XCTAssertGreaterThanOrEqual(first.frame.minY,search.frame.maxY - 0.5)
  XCTAssertLessThan(first.frame.height,130)
  XCTAssertGreaterThanOrEqual(second.frame.minY,first.frame.maxY - 0.5)
  XCTAssertFalse(app.staticTexts["Idle"].exists)
  XCTAssertFalse(app.staticTexts["Read"].exists)
  XCTAssertTrue(app.tabBars.buttons["Knowledge"].exists)
  capture(app,"simple-chats")
  search.tap();if app.buttons["Continue"].exists { app.buttons["Continue"].tap() };search.typeText("landing")
  XCTAssertTrue(second.waitForExistence(timeout:5));XCTAssertFalse(first.exists)
  app.buttons["Clear search"].tap();XCTAssertTrue(first.waitForExistence(timeout:5))
  app.buttons["New chat"].tap();XCTAssertTrue(app.navigationBars["New session"].waitForExistence(timeout:5))
  app.buttons["Cancel"].tap()
  first.tap()
  XCTAssertTrue(app.textFields["Message your Mac…"].waitForExistence(timeout:10))
  XCTAssertFalse(app.tabBars.buttons["Knowledge"].exists)
  app.navigationBars.buttons.element(boundBy:0).tap()
  XCTAssertTrue(app.tabBars.buttons["Knowledge"].waitForExistence(timeout:5))
  app.buttons["Settings"].tap();XCTAssertTrue(app.buttons["Pair another Mac"].waitForExistence(timeout:5))
 }
 func testLargeTextLayout() {
  let app=XCUIApplication();app.launchArguments=["-UIPreferredContentSizeCategoryName","UICTContentSizeCategoryAccessibilityXXXL"];app.launch()
  let first=app.buttons["session-layout-0"];XCTAssertTrue(first.waitForExistence(timeout:20))
  let second=app.buttons["session-layout-1"]
  XCTAssertGreaterThanOrEqual(second.frame.minY,first.frame.maxY - 0.5)
  XCTAssertLessThanOrEqual(first.frame.maxX,app.frame.maxX)
  XCTAssertTrue(app.tabBars.buttons["Knowledge"].isHittable)
  capture(app,"simple-chats-large-text")
 }
 func testWikiNavigation() {
  let app=XCUIApplication();app.launch()
  let wiki=app.tabBars.buttons["Knowledge"];XCTAssertTrue(wiki.waitForExistence(timeout:20));wiki.tap()
  let example=app.buttons["wiki-article-work/example~1"];XCTAssertTrue(example.waitForExistence(timeout:15));example.tap()
  let inline=app.links["analytics guide"];XCTAssertTrue(inline.waitForExistence(timeout:15));inline.tap()
  XCTAssertTrue(app.navigationBars["Example analytics"].waitForExistence(timeout:15))
  XCTAssertTrue(app.staticTexts["Revenue is measured per billing account."].waitForExistence(timeout:10))
  let sources=app.buttons["Sources and evidence"];XCTAssertTrue(sources.exists);sources.tap()
  XCTAssertTrue(app.staticTexts["1. User stated: Revenue excludes refunds."].waitForExistence(timeout:5))
  let shot=XCTAttachment(screenshot:app.screenshot());shot.name="wiki-article";shot.lifetime = .keepAlways;add(shot)
  app.navigationBars.buttons.element(boundBy:0).tap()
  XCTAssertTrue(app.links["analytics guide"].waitForExistence(timeout:10))
  app.buttons["Wiki home"].tap();XCTAssertTrue(example.waitForExistence(timeout:10))
 }
}
''')
# Reuse the existing project's test-target shape, with the current formatted PBX project.
scaffold=(root/'scripts/test-session-flow-ui.py').read_text();start=scaffold.index("objects='''")+len("objects='''");end=scaffold.index("'''",start);objects=scaffold[start:end]
objects=objects.replace('path = ConversationUITests/ConversationUITests.swift; sourceTree = "<group>";',f'path = "{tests / "ConversationUITests.swift"}"; sourceTree = "<absolute>";')
project=work/'ios/AgentRemote.xcodeproj/project.pbxproj';p=project.read_text().replace('objects = {','objects = {'+objects,1);p=p.replace('targets = (','targets = (AAA000000000000000000010,',1).replace('com.agentremote.personal','com.agentremote.wikifixture');project.write_text(p)
schemes=project.parent/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
ref=lambda id,name:f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{id}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:AgentRemote.xcodeproj"/>'
(schemes/'WikiUI.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2660" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref('34A04005BCAF206EEC990BD9','AgentRemote.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref('AAA000000000000000000010','ConversationUITests.xctest')}</TestableReference></Testables></TestAction></Scheme>''')
device=subprocess.check_output(['xcrun','simctl','create','Agent Remote Wiki Test','com.apple.CoreSimulator.SimDeviceType.iPhone-16','com.apple.CoreSimulator.SimRuntime.iOS-26-5'],env=env,text=True).strip()
try:
 subprocess.run(['xcodebuild','-quiet','-project',str(project.parent),'-scheme','WikiUI','-destination','platform=iOS Simulator,id='+device,'-derivedDataPath',str(work/'derived'),'-resultBundlePath',str(work/'results.xcresult'),'CODE_SIGNING_ALLOWED=NO','test'],env=env,check=True,timeout=600)
 assert any('revision=1' in r for r in requests);print('iPhone wiki list, inline link, article pagination, sources, back, and home passed.')
finally:
 subprocess.run(['xcrun','simctl','shutdown',device],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);subprocess.run(['xcrun','simctl','delete',device],env=env,stdout=subprocess.DEVNULL);server.shutdown()
