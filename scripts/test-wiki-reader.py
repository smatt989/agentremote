#!/usr/bin/env python3
"""Exercise production Mac wiki decoding, pagination, navigation, and native rendering."""
import http.server, json, os, pathlib, subprocess, tempfile, threading, urllib.parse
ROOT=pathlib.Path(__file__).resolve().parents[1]
ENV=dict(os.environ,DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
with tempfile.TemporaryDirectory(prefix='agentremote-wiki-ui-') as folder:
    base=pathlib.Path(folder)
    entries=[dict(id='work/example~1',topic='work/example',title='Example',summary='A guide to Example and its analytics environment.',parent=None,kind='overview'),dict(id='work/example/analytics~1',topic='work/example/analytics',title='Example analytics',summary='Definitions, sources, and tools for understanding the business.',parent='work/example~1',kind='article')]
    markdown='# Example analytics\n\nThe analytics workspace connects business definitions with reliable data. Start with [Example](agentremote-wiki://article?id=work%2Fexample~1) for company context.\n\n## Data model\n\nRevenue is measured at the **billing account** grain. Refunds are excluded from recurring revenue. [source 1]\n\n## Working with the data\n\n- Check the account grain before joining tables.\n- Keep historical definitions alongside explicit corrections.\n\n## Explore this topic\n\n## Related pages\n\n## Sources\n\n1. User stated; September 9, 2026.\n   Revenue excludes refunds.'
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            if self.headers.get('Authorization')!='Bearer fixture-token': self.send_error(401);return
            url=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(url.query);offset=int(q.get('offset',['0'])[0])
            if url.path=='/knowledge': result=dict(results=entries[offset:offset+1])
            else:
                id=q.get('id',[''])[0];item=next((e for e in entries if e['id']==id),None)
                result=dict(page=None if not item else dict(id=id,title=item['title'],markdown=markdown[offset:offset+180],nextOffset=offset+180 if offset+180<len(markdown) else None,related=[dict(id=entries[0]['id'],title='Example')],breadcrumbs=[dict(id=entries[0]['id'],title='Example')],children=[],backlinks=[],updatedAt=1788984000000,revision=1,pending=False))
            body=json.dumps(result).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    (base/'desktop-token').write_text('fixture-token');(base/'desktop-status.json').write_text(json.dumps(dict(port=server.server_port)))
    (base/'Main.swift').write_text(r'''
import AppKit
import SwiftUI
@main struct WikiReaderTest {
 @MainActor static func main() {
  let app=NSApplication.shared;app.setActivationPolicy(.accessory)
  Task { @MainActor in
   let model=WikiModel();await model.search("");precondition(model.entries.count==2)
   model.navigate("work/example~1");model.navigate("work/example/analytics~1");await model.read(model.selected!)
   precondition(model.markdown.contains("Revenue excludes refunds."));precondition(model.page?.breadcrumbs?.first?.title=="Example")
   let url=URL(string:"agentremote-wiki://article?id=work%2Fexample~1")!
   precondition(WikiAPI.articleID(url)=="work/example~1");precondition(WikiAPI.articleID(URL(string:"file:///tmp/test")!)==nil)
   model.goBack();precondition(model.selected=="work/example~1");model.goForward();precondition(model.selected=="work/example/analytics~1")
   let window=NSWindow(contentRect:NSRect(x:0,y:0,width:1180,height:800),styleMask:[.titled,.resizable],backing:.buffered,defer:false)
   window.contentView=NSHostingView(rootView:WikiView(model:model));window.center();window.makeKeyAndOrderFront(nil)
   try? await Task.sleep(nanoseconds:1_000_000_000)
   if let view=window.contentView,let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds){view.cacheDisplay(in:view.bounds,to:bitmap);if let data=bitmap.representation(using:.png,properties:[:]),let path=ProcessInfo.processInfo.environment["SNAPSHOT"]{try? data.write(to:URL(fileURLWithPath:path))}}
   print("Wiki list/page pagination, URL routing, back/forward, breadcrumbs, and native rendering passed.");exit(0)
  }
  app.run()
 }
}
''')
    binary=base/'WikiTest'
    subprocess.run(['xcrun','swiftc','-parse-as-library',ROOT/'macos/KnowledgeBrowser/WikiView.swift',ROOT/'macos/AgentRemote/MessageMarkdown.swift',base/'Main.swift','-o',binary],env=ENV,check=True)
    subprocess.run([binary],env=dict(ENV,AGENT_REMOTE_STATE=str(base),SNAPSHOT=str(ROOT/'build/wiki-reader-preview.png')),check=True,timeout=30)
    server.shutdown()
