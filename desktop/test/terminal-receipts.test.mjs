import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Store} from '../src/store.mjs';import {Providers} from '../src/providers.mjs';
test('terminal receipt survives native trimming, repeated history and a second identical send',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-receipt-'));const store=new Store(dir),p=new Providers(store);t.after(()=>{p.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const id='claude:test',transcript=join(dir,'t.jsonl');store.save({id,provider:'claude',providerId:'test',transcript,status:'idle'});p.claudeActivity=async()=>[];
 const terminal={prompts:new Map(),close:async()=>{}};p.terminals.set(id,terminal);const now=Date.now();const rows=[];
 for(let n=1;n<=2;n++){
  terminal.prompts.set('send'+n,{id:'send'+n,text:'  Coffee\r\nplease  ',createdAt:now+n*3000});
  rows.push({type:'user',uuid:'native'+n,timestamp:new Date(now+n*3000+50).toISOString(),message:{content:'Coffee\nplease'}});
  rows.push({type:'assistant',timestamp:new Date(now+n*3000+100).toISOString(),message:{id:'reply'+n,content:[{type:'text',text:'Reply '+n}]}});
  writeFileSync(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');await p.history(id);await p.history(id);
  const users=store.messages(id).filter(m=>m.role==='user');assert.equal(users.length,n);assert.equal(users.at(-1).requestId,'send'+n);assert.equal(terminal.prompts.size,0);
 }
 assert.deepEqual(store.messages(id).filter(m=>m.role==='user').map(m=>m.requestId),['send1','send2']);
});
test('receipt can merge with an already imported native user message',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-ack-'));const s=new Store(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});s.save({id:'x'});
 s.message('x',{id:'native',role:'user',kind:'text',text:'Hello'});s.claim('request','x',{text:'Hello '});s.message('x',{id:'request',role:'user',kind:'text',text:'Hello '});
 s.userAcknowledgement('x',{id:'native',role:'user',kind:'text',text:'Hello'});assert.equal(s.messages('x').length,1);assert.equal(s.messages('x')[0].requestId,'request');
});
