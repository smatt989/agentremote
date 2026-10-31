import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import headless from '@xterm/headless';import {Store} from '../src/store.mjs';import {writeDesktopStatus} from '../src/desktop-status.mjs';import {terminalRestoreSequence} from '../src/terminal-cleanup.mjs';
for(const ending of ['ended','deleted'])test('launcher restores terminal emulator modes after remote '+ending,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-cleanup-')),store=new Store(dir);const token=store.desktopToken();let reads=0;let child;
 const server=createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);for await(const _ of req){}let result;
  if(req.url==='/terminal/claude')result={id:'claude:fixture'};
  else if(req.url.endsWith('/control'))result={generation:1};
  else if(ending==='deleted'&&reads++){res.statusCode=404;result={error:'This shared terminal is no longer running.'};}
  else{reads++;result={generation:1,owner:'you',seq:1,reset:false,ended:ending==='ended',data:Buffer.from('\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h\x1b[?25l').toString('base64')};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));writeDesktopStatus(store,{port:server.address().port,relay:'test'});
 const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const command=q(process.execPath)+' '+q(resolve('desktop/src/terminal.mjs'))+' claude /bin/cat; printf CLEAN_SHELL';
 try{
  child=spawn('python3',['-u',resolve('scripts/terminal-fixture.py'),JSON.stringify(['/bin/zsh','-c',command])],{env:{...process.env,AGENT_REMOTE_STATE:dir},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',()=>{});
  const timeout=setTimeout(()=>child.kill(),10000);await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});clearTimeout(timeout);
  assert.ok(output.includes(terminalRestoreSequence),'Exit cleanup must be emitted in full');assert.ok(output.includes('CLEAN_SHELL'),'Control returns to the shell');
  const term=new headless.Terminal({allowProposedApi:true});await new Promise(r=>term.write(output,r));assert.equal(term.modes.mouseTrackingMode,'none');assert.equal(term.modes.bracketedPasteMode,false);assert.equal(term.modes.applicationCursorKeysMode,false);term.dispose();
 }finally{child?.kill();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
});
