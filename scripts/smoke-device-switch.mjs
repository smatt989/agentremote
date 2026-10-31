import {fixtureDirectory} from './fixture-directory.mjs';
// Real provider turns through the same API used by the native Mac and phone clients.
// Only creates/deletes this invocation's disposable conversation.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../desktop/src/store.mjs';
import {createServer} from '../desktop/src/server.mjs';
const provider=process.argv[2]||'codex';
assert.ok(['codex','claude'].includes(provider));
const directory=fixtureDirectory('agentremote-switch-');
const store=new Store(join(directory,'state'));
const {server,providers}=createServer({store});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const desktop=store.desktopToken(),phone=store.createDevice('Disposable phone').token;
async function api(token,path,body) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();if(!response.ok)throw Error(value.error);return value;
}
let id;
try {
  const created=await api(desktop,'/sessions',{provider,cwd:directory,title:'Disposable device switch'});id=created.id;
  const path='/sessions/'+encodeURIComponent(id);
  for(const [token,text] of [[desktop,'Remember the code word ORCHARD. Reply only OK. Do not use tools.'],[phone,'What is the code word? Reply only with the word. Do not use tools.'],[desktop,'What is the code word? Reply only with the word. Do not use tools.']]) {
    const requestId=randomUUID();await api(token,path+'/messages',{text,requestId});
    const deadline=Date.now()+150000;
    while(['running','submitting','waiting'].includes(store.session(id).status)){assert.ok(Date.now()<deadline,'Turn timed out');await new Promise(resolve=>setTimeout(resolve,250));}
    assert.equal(store.session(id).status,'idle',store.messages(id).filter(m=>m.kind==='error').map(m=>m.text).join('\n'));
    const [macView,phoneView]=await Promise.all([api(desktop,path),api(phone,path)]);
    assert.equal(macView.session.id,id);assert.equal(phoneView.session.id,id);
    assert.deepEqual(macView.messages,phoneView.messages);
    if(text.startsWith('What'))assert.ok(phoneView.messages.filter(m=>m.role==='assistant').at(-1)?.text.includes('ORCHARD'),'Same conversation retained context');
  }
  console.log(provider+': desktop → phone → desktop, identical history and retained context passed.');
} finally {
  if(id)await providers.remove(id).catch(e=>console.error('Fixture cleanup:',e.message));
  providers.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});
}
