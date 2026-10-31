import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Providers } from '../src/providers.mjs';
import { isTemporarySessionDirectory, isStateNoteSession } from '../src/session-visibility.mjs';

test('temporary path classification respects directory boundaries',()=>{
  for(const path of ['/tmp','/private/tmp/','/tmp/job','/private/tmp/job'])assert.equal(isTemporarySessionDirectory(path),true);
  for(const path of ['/tmp-project','/private/tmp-project','/Users/me/project','/tmp/../Users/me',undefined])assert.equal(isTemporarySessionDirectory(path),false);
});
test('cached temporary imports are hidden without deleting history or managed scratch work',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ar-visibility-'));const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  for(const s of [{id:'imported',cwd:'/private/tmp',external:true},{id:'managed',cwd:'/tmp/project',external:false},{id:'helper',cwd:'/private/tmp',external:false,internal:true},{id:'project',cwd:'/Users/me/project',external:true}])store.save(s);
  store.message('imported',{id:'m',role:'user',kind:'text',text:'Preserve me'});
  assert.deepEqual(store.sessions().map(s=>s.id).sort(),['managed','project']);
  assert.ok(store.session('imported'));assert.equal(store.messages('imported')[0].text,'Preserve me');
});
test('background state-note jobs are recognized by directory and structured prompt',()=>{
  const text='Keep a running state note for a working session, so it can be picked up after a\nrestart.\nheadline: at most 8 words naming what this session is doing.\nsummary: under 180 words';
  assert.equal(isStateNoteSession('/private/tmp',[{type:'user',message:{content:text}}]),true);
  assert.equal(isStateNoteSession('/tmp',[{type:'user',message:{content:[{type:'text',text}]}}]),true);
  assert.equal(isStateNoteSession('/Users/me/project',[{type:'user',message:{content:text}}]),false);
  assert.equal(isStateNoteSession('/tmp',[{type:'user',message:{content:'Help me build something'}}]),false);
});
test('Codex discovery and notifications do not introduce scratch jobs',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ar-visibility-'));const store=new Store(dir);const providers=new Providers(store);
  t.after(()=>{providers.close();store.close();rmSync(dir,{recursive:true,force:true});});
  providers.discoverClaude=async()=>{};
  providers.codex=async()=>({call:async method=>({data:method==='thread/loaded/list'?[]:[{id:'scratch',cwd:'/private/tmp',updatedAt:1},{id:'project',cwd:'/Users/me/project',updatedAt:1}]})});
  await providers.discover();assert.equal(store.session('codex:scratch'),undefined);assert.ok(store.session('codex:project'));
  providers.codexEvent({}, {method:'thread/started',params:{thread:{id:'background',cwd:'/tmp/task'}}});
  assert.equal(store.session('codex:background'),undefined);
});
