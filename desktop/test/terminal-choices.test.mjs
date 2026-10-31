import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {parseChoiceDialog,answerChoiceDialog} from '../src/terminal-questions.mjs';
import {Store} from '../src/store.mjs';import {Providers} from '../src/providers.mjs';import {pendingQuestions} from '../src/questions.mjs';

const fast={poll:1,timeout:300,settle:1};
// Claude Code's folder-trust prompt as captured from a real resumed shared terminal (Oct 30 2026).
const trustLines=highlight=>['','─'.repeat(40),' Accessing workspace:','',' /Users/me','',' Quick safety check: Is this a project you created or one you trust?','',' Security guide','',
 (highlight===0?' ❯ ':'   ')+'No, exit',(highlight===1?' ❯ ':'   ')+'Yes, I trust this folder','',' Enter to confirm · Esc to cancel',''];
class FakeChoice{
 constructor(lines,count){this.make=lines;this.count=count;this.highlight=0;this.chosen=null;this.writes=[];this.ended=false;this.inputRevision=0;}
 async lines(){return this.chosen===null?this.make(this.highlight):['','❯ ','─'.repeat(40)];}
 write(bytes){this.writes.push(bytes);this.inputRevision++;
  if(bytes==='\x1b[B')this.highlight=Math.min(this.count-1,this.highlight+1);else if(bytes==='\x1b[A')this.highlight=Math.max(0,this.highlight-1);else if(bytes==='\r')this.chosen=this.highlight;}
}
test('trust, numbered permission prompts and their details parse; prompts and question dialogs do not',()=>{
 const trust=parseChoiceDialog(trustLines(0));
 assert.deepEqual(trust.options.map(o=>o.label),['No, exit','Yes, I trust this folder']);assert.equal(trust.highlight,0);
 assert.match(trust.titleText,/^Accessing workspace: \/Users\/me Quick safety check/);
 const permission=parseChoiceDialog(['⏺ Bash(rm -rf build)','─'.repeat(40),' Bash command','','   rm -rf build','',' Do you want to proceed?',' ❯ 1. Yes','   2. Yes, and don\'t ask again for rm commands','      in /Users/me','   3. No, and tell Claude what to do differently (esc)','',' Esc to cancel']);
 assert.deepEqual(permission.options.map(o=>o.label),['Yes','Yes, and don\'t ask again for rm commands','No, and tell Claude what to do differently (esc)']);
 assert.equal(permission.options[1].description,'in /Users/me');assert.match(permission.titleText,/Do you want to proceed\?$/);
 assert.equal(parseChoiceDialog(['❯ ','─'.repeat(40),'  ⏵⏵ auto mode on']),null);
 assert.equal(parseChoiceDialog(['❯ some text Esc to cancel']),null);
 assert.equal(parseChoiceDialog([...trustLines(0),'⏺ Done.','─'.repeat(40),'❯ ','─'.repeat(40),'  ⏵⏵ auto mode on']),null);
 assert.equal(parseChoiceDialog(['─'.repeat(40),' ☐ Pet ','','│ Which pet?','','❯ 1. Cat','  2. Dog','  3. Type something.','  4. Chat about this','','Enter to select · ↑/↓ to navigate · Esc to cancel']),null);
});
test('a choice is made with arrow keys and Enter, verified on screen',async()=>{
 const term=new FakeChoice(trustLines,2);const view=parseChoiceDialog(trustLines(0));
 const question={dialogKey:view.key,questions:[{id:'0',options:view.options}]};
 await assert.rejects(answerChoiceDialog(term,question,{'0':'Maybe'},fast),/Choose one of the options/);assert.deepEqual(term.writes,[]);
 await answerChoiceDialog(term,question,{'0':'Yes, I trust this folder'},fast);
 assert.deepEqual(term.writes,['\x1b[B','\r']);assert.equal(term.chosen,1);
 // A different prompt on screen is never answered.
 const other=new FakeChoice(h=>trustLines(h).map(l=>l.replace('/Users/me','/tmp')),2);
 await assert.rejects(answerChoiceDialog(other,question,{'0':'No, exit'},fast),/no longer showing this prompt/);assert.deepEqual(other.writes,[]);
});
test('a resumed terminal waiting on folder trust shows a tap-to-answer card',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-terminal-choice-'));const store=new Store(dir);const providers=new Providers(store);
 t.after(()=>{providers.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const id='claude:test',transcript=join(dir,'t.jsonl');providers.claudeActivity=async()=>[];providers.discoverClaude=async()=>{};
 const term=Object.assign(new FakeChoice(trustLines,2),{prompts:new Map(),close:async()=>{}});providers.terminals.set(id,term);
 store.save({id,provider:'claude',providerId:'test',transcript,status:'idle',control:'terminal',terminal:true});
 writeFileSync(transcript,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{content:'hi'}})+'\n');
 await providers.history(id);
 const [card]=pendingQuestions(store,id);assert.ok(card);assert.equal(card.choice,true);assert.equal(card.choiceOnly,true);
 assert.deepEqual(card.questions[0].options.map(o=>o.label),['No, exit','Yes, I trust this folder']);
 await providers.history(id);assert.equal(pendingQuestions(store,id).length,1);
 await providers.answer(id,card.id,{[card.questions[0].id]:'Yes, I trust this folder'});
 assert.equal(term.chosen,1);assert.equal(pendingQuestions(store,id).length,0);
 assert.ok(store.messages(id).some(m=>m.role==='user'&&m.text==='Yes, I trust this folder'));
 await providers.history(id);assert.equal(pendingQuestions(store,id).length,0);
});
test('a card whose prompt disappears from the screen is withdrawn',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-terminal-choice-'));const store=new Store(dir);const providers=new Providers(store);
 t.after(()=>{providers.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const id='claude:test',transcript=join(dir,'t.jsonl');providers.claudeActivity=async()=>[];providers.discoverClaude=async()=>{};
 const term=Object.assign(new FakeChoice(trustLines,2),{prompts:new Map(),close:async()=>{}});providers.terminals.set(id,term);
 store.save({id,provider:'claude',providerId:'test',transcript,status:'idle',control:'terminal',terminal:true});
 writeFileSync(transcript,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{content:'hi'}})+'\n');
 await providers.history(id);assert.equal(pendingQuestions(store,id).length,1);
 // Answered at the Mac: a different prompt replaces it at once.
 term.make=h=>trustLines(h).map(l=>l.replace('/Users/me','/tmp'));await providers.history(id);
 const [next]=pendingQuestions(store,id);assert.ok(next);assert.match(next.questions[0].title,/\/tmp/);
});
