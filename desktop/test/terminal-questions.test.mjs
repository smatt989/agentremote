import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {answerTerminalQuestion,parseDialog,multiSelectChoice,screenQuestion,REVIEW_TITLE} from '../src/terminal-questions.mjs';
import {Store} from '../src/store.mjs';import {Providers} from '../src/providers.mjs';import {pendingQuestions} from '../src/questions.mjs';

// Simulates Claude Code's native question dialog as observed in a real shared terminal:
// digits select or toggle, the row after the options is free text, multiple choice ends
// with a Submit/Next row, and every dialog except a lone single-choice question finishes
// on a review tab.
class FakeDialog{
 constructor(questions,{digitsOnlyHighlight=false}={}){
  this.questions=questions.map(q=>({...q,options:q.options.map(o=>typeof o==='string'?{label:o}:o),selected:new Set(q.selected||[]),text:q.text||'',textChecked:!!q.textChecked,highlight:q.highlight||0,answer:undefined,answered:false}));
  this.tab=0;this.review=false;this.submitted=null;this.cancelled=false;this.ended=false;this.writes=[];this.inputRevision=0;this.digitsOnlyHighlight=digitsOnlyHighlight;
 }
 get multiTab(){return this.questions.length>1||this.questions[0].multiSelect;}
 rows(q){
  const rows=q.options.map((o,i)=>({number:i+1,label:o.label,checked:q.multiSelect?q.selected.has(o.label):undefined}));
  rows.push({number:q.options.length+1,label:q.text||('Type something'+(q.multiSelect?'':'.')),checked:q.multiSelect?q.textChecked:undefined,text:true});
  if(q.multiSelect)rows.push({action:this.questions.length>1?'Next':'Submit'});
  rows.push({number:q.options.length+2,label:'Chat about this'});
  return rows;
 }
 async lines(){
  if(this.submitted||this.cancelled)return ['⏺ User answered Claude\'s questions','','❯ ',''];
  const q=this.questions[this.tab];
  const tabs=this.multiTab?'←  '+this.questions.map(x=>(x.answered?'☒ ':'☐ ')+x.header).join('  ')+'  ✔ Submit  →':' ☐ '+q.header+' ';
  if(this.review)return ['❯ old prompt','',tabs,'','Review your answers','',...this.questions.flatMap(x=>[' ● '+x.question,'   → '+(x.answer||'')]),'','Ready to submit your answers?','     ','❯ 1. Submit answers','  2. Cancel',''];
  const rows=this.rows(q);const textMode=!!rows[q.highlight].text;
  const body=rows.flatMap((r,i)=>{const mark=i===q.highlight?'❯ ':'  ';if(r.action)return [mark+'   '+r.action];const box=r.checked===undefined?'':r.checked?'[✔] ':'[ ] ';return [mark+r.number+'. '+box+r.label,...(i<q.options.length?['     '+r.label+' description']:[])];});
  return ['❯ Use the AskUserQuestion tool now. Enter to select nothing here.','────────',tabs,'','│ '+q.question,'',...body,'','Enter to select · '+(this.multiTab?'Tab/Arrow keys':'↑/↓')+' to navigate · '+(textMode?'ctrl+g to edit in Vim · ':'')+'Esc to cancel',''];
 }
 write(bytes){
  this.writes.push(bytes);this.inputRevision++;
  let rest=bytes;
  while(rest.length){
   const paste=rest.match(/^\x1b\[200~([\s\S]*?)\x1b\[201~/);
   if(paste){this.paste(paste[1]);rest=rest.slice(paste[0].length);continue;}
   const seq=rest.match(/^\x1b\[[A-Z]/);
   if(seq){this.key(seq[0]);rest=rest.slice(seq[0].length);continue;}
   this.key(rest[0]);rest=rest.slice(1);
  }
 }
 advance(){const q=this.questions[this.tab];q.answered=true;if(this.tab<this.questions.length-1)this.tab++;else if(!this.multiTab)this.finish();else this.review=true;}
 finish(){this.submitted=Object.fromEntries(this.questions.map(q=>[q.question,q.multiSelect?[...q.options.filter(o=>q.selected.has(o.label)).map(o=>o.label),...(q.textChecked&&q.text?[q.text]:[])].join(', '):q.answer]));}
 paste(text){const q=this.questions[this.tab];if(this.review||!this.rows(q)[q.highlight].text)return;q.text+=text;if(q.multiSelect)q.textChecked=true;}
 key(k){
  if(this.review){if(k==='1'||k==='\r')this.finish();else if(k==='\x1b[Z'){this.review=false;this.tab=this.questions.length-1;}return;}
  const q=this.questions[this.tab];const rows=this.rows(q);const row=rows[q.highlight];const textMode=!!row.text;const N=q.options.length;
  if(k==='\x1b[A'){if(q.highlight>0)q.highlight--;return;}
  if(k==='\x1b[B'){if(q.highlight<rows.length-1)q.highlight++;return;}
  if(k==='\t'){if(!this.multiTab)return;if(textMode&&q.multiSelect){q.highlight=rows.findIndex(r=>r.action);return;}if(this.tab<this.questions.length-1)this.tab++;else this.review=true;return;}
  if(k==='\x1b[Z'){if(this.tab>0)this.tab--;return;}
  if(k==='\r'){
   if(row.action){this.advance();return;}
   if(row.number===N+2){this.cancelled=true;return;}
   if(q.multiSelect){if(row.text)q.textChecked=!q.textChecked;else q.selected.has(row.label)?q.selected.delete(row.label):q.selected.add(row.label);return;}
   if(row.text){if(q.text){q.answer=q.text;this.advance();}return;}
   q.answer=row.label;this.advance();return;
  }
  if(textMode){if(k==='\x15')q.text='';else if(k==='\x7f')q.text=q.text.slice(0,-1);else if(k>=' '){q.text+=k;if(q.multiSelect)q.textChecked=true;}return;}
  if(/^[1-9]$/.test(k)){
   const target=rows.filter(r=>r.number)[Number(k)-1];if(!target)return;
   const position=rows.indexOf(target);
   if(this.digitsOnlyHighlight){q.highlight=position;return;}
   if(target.number===N+2){this.cancelled=true;return;}
   if(q.multiSelect){if(target.text)q.textChecked=!q.textChecked;else q.selected.has(target.label)?q.selected.delete(target.label):q.selected.add(target.label);return;}
   q.highlight=position;
   if(target.text)return;
   q.answer=target.label;this.advance();
  }
 }
}
const fast={poll:1,timeout:400,settle:1};
const item=(id,title,options,multiSelect=false)=>({id,title,multiSelect,options:options.map(label=>({label,description:''}))});

test('parses the real dialog layout including checkboxes, free text, action rows and review',()=>{
 const view=parseDialog(['❯ old prompt','────','←  ☒ Size  ☐ Toppings  ✔ Submit  →','','Which toppings?','','❯ 1. [✔] Cheese','  Cheese topping','  2. [ ] Olives','  3. [ ] Type something','     Submit','────','  4. Chat about this','','Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
 assert.equal(view.multiTab,true);assert.equal(view.title,'whichtoppings?');assert.equal(view.highlight,0);assert.equal(view.textMode,false);
 assert.deepEqual(view.rows.map(r=>r.action||r.number),[1,2,3,'Submit',4]);assert.equal(view.rows[0].checked,true);assert.equal(view.rows[1].checked,false);
 assert.equal(view.titleText,'Which toppings?');assert.equal(view.multiSelect,true);assert.equal(view.questionCount,2);assert.deepEqual(view.options,[{label:'Cheese',description:'Cheese topping'},{label:'Olives',description:''}]);
 assert.deepEqual(screenQuestion(view),{review:false,questions:[{question:'Which toppings?',multiSelect:true,options:[{label:'Cheese',description:'Cheese topping'},{label:'Olives',description:''}]}]});
 const single=parseDialog(['', ' ☐ Mood ','','How are you feeling?','','  1. Happy','  2. Tired','❯ 3. Sparkling green','','Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel']);
 assert.equal(single.multiTab,false);assert.equal(single.textMode,true);assert.equal(single.highlight,2);
 assert.equal(parseDialog(['Enter to select · old hint in scrollback','❯ ']),null);
 assert.deepEqual(parseDialog(['Enter to select','☐ A','Review your answers','Ready to submit your answers?','❯ 1. Submit answers','  2. Cancel']),{review:true,textMode:false,submitOption:1,cancelOption:2,incomplete:false});
 assert.equal(parseDialog(['☐ A','You have not answered all questions','❯ 1. Submit answers','  2. Cancel']).incomplete,true);
 const wrapped=parseDialog([' ☐ Apple access ','','│ How do you want to give Xcode access to your Apple Developer account (team','│ YA9PU25M2S) so I can sign and upload?','','❯ 1. Sign in to Xcode (Recommended)','    Open Xcode → Settings → Accounts, complete 2FA.','     Then tell me.','  2. Hold for now','     Leave everything in place.','  3. Type something.','────────','  4. Chat about this','','Enter to select · ↑/↓ to navigate · Esc to cancel']);
 assert.equal(wrapped.titleText,'How do you want to give Xcode access to your Apple Developer account (team YA9PU25M2S) so I can sign and upload?');assert.equal(wrapped.multiTab,false);assert.deepEqual(wrapped.options.map(o=>o.label),['Sign in to Xcode (Recommended)','Hold for now']);assert.equal(wrapped.options[0].description,'Open Xcode → Settings → Accounts, complete 2FA. Then tell me.');
 assert.deepEqual([...multiSelectChoice(item('0','t',['Apples','Nuts']),'Apples, Nuts')],['Apples','Nuts']);assert.equal(multiSelectChoice(item('0','t',['Apples']),'Pears'),null);
});
test('a lone single-choice question submits with one digit',async()=>{
 const dialog=new FakeDialog([{header:'Pet',question:'Which pet?',options:['Cat','Dog']}]);
 await answerTerminalQuestion(dialog,{questions:[item('0','Which pet?',['Cat','Dog'])]},{'0':'Dog'},fast);
 assert.deepEqual(dialog.writes,['2']);assert.deepEqual(dialog.submitted,{'Which pet?':'Dog'});
});
test('free text opens the typed option, pastes and confirms',async()=>{
 const dialog=new FakeDialog([{header:'Mood',question:'How are you feeling?',options:['Happy','Tired']}]);
 await answerTerminalQuestion(dialog,{questions:[item('0','How are you feeling?',['Happy','Tired'])]},{'0':'Sparkling\ngreen'},fast);
 assert.deepEqual(dialog.writes,['3','\x1b[200~Sparkling green\x1b[201~','\r']);assert.deepEqual(dialog.submitted,{'How are you feeling?':'Sparkling green'});
});
test('multiple questions with choices, toggles and the review tab submit together',async()=>{
 const dialog=new FakeDialog([{header:'Drink',question:'Which drink do you prefer?',options:['Tea','Coffee','Water']},{header:'Snacks',question:'Which snacks should I bring?',multiSelect:true,options:['Apples','Nuts','Chips']}]);
 const question={questions:[item('0','Which drink do you prefer?',['Tea','Coffee','Water']),item('1','Which snacks should I bring?',['Apples','Nuts','Chips'],true)]};
 await answerTerminalQuestion(dialog,question,{'0':'Coffee','1':'Apples, Chips'},fast);
 assert.deepEqual(dialog.submitted,{'Which drink do you prefer?':'Coffee','Which snacks should I bring?':'Apples, Chips'});
 assert.deepEqual(dialog.writes,['2','1','3','\x1b[B','\x1b[B','\x1b[B','\x1b[B','\r','1']);
});
test('recovers from a desktop user who tabbed ahead, left text and pre-checked options',async()=>{
 const dialog=new FakeDialog([{header:'Size',question:'Which size?',options:['Small','Large']},{header:'Toppings',question:'Which toppings?',multiSelect:true,options:['Cheese','Olives'],selected:['Cheese'],text:'ol',textChecked:true,highlight:2}]);
 dialog.tab=1;
 const question={questions:[item('0','Which size?',['Small','Large']),item('1','Which toppings?',['Cheese','Olives'],true)]};
 await answerTerminalQuestion(dialog,question,{'0':'Small','1':'Pineapple'},fast);
 assert.deepEqual(dialog.submitted,{'Which size?':'Small','Which toppings?':'Pineapple'});
 assert.ok(dialog.writes.includes('\x1b[Z'),'moved back to the first question');assert.ok(dialog.writes.includes('\x15'),'cleared leftover text');
});
test('falls back to Enter when a digit only moves the highlight',async()=>{
 const dialog=new FakeDialog([{header:'A',question:'First?',options:['One','Two']},{header:'B',question:'Second?',options:['Red','Blue']}],{digitsOnlyHighlight:true});
 await answerTerminalQuestion(dialog,{questions:[item('0','First?',['One','Two']),item('1','Second?',['Red','Blue'])]},{'0':'Two','1':'Red'},fast);
 assert.deepEqual(dialog.submitted,{'First?':'Two','Second?':'Red'});assert.deepEqual(dialog.writes,['2','\r','1','\r','1']);
});
test('refuses when the dialog is missing or shows a different question, without sending keys',async()=>{
 const gone={ended:false,writes:[],async lines(){return ['❯ '];},write(b){this.writes.push(b);}};
 await assert.rejects(answerTerminalQuestion(gone,{questions:[item('0','Which pet?',['Cat','Dog'])]},{'0':'Dog'},fast),/not showing this question/);
 assert.deepEqual(gone.writes,[]);
 const other=new FakeDialog([{header:'Pet',question:'Which pet?',options:['Cat','Dog']}]);
 await assert.rejects(answerTerminalQuestion(other,{questions:[item('0','Which colour?',['Red','Blue'])]},{'0':'Red'},fast),/different question/);
 assert.deepEqual(other.writes,[]);assert.equal(other.submitted,null);
});
function providerFixture(t,dialog){
 const dir=mkdtempSync(join(tmpdir(),'ar-terminal-question-'));const store=new Store(dir);const providers=new Providers(store);
 t.after(()=>{providers.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const id='claude:test',transcript=join(dir,'t.jsonl');providers.claudeActivity=async()=>[];providers.discoverClaude=async()=>{};
 const attach=d=>{Object.assign(d,{prompts:new Map(),close:async()=>{}});providers.terminals.set(id,d);return d;};
 if(dialog)attach(dialog);
 store.save({id,provider:'claude',providerId:'test',transcript,status:'waiting',control:'terminal',terminal:true});
 const write=rows=>writeFileSync(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 write([{type:'user',timestamp:new Date().toISOString(),message:{content:'Ask me'}}]);
 return {store,providers,id,write,attach};
}
const ask=(toolId,questions)=>({type:'assistant',timestamp:new Date().toISOString(),message:{id:'m-'+toolId,content:[{type:'tool_use',id:toolId,name:'AskUserQuestion',input:{questions}}]}});
const petQuestion=[{question:'Which pet?',header:'Pet',options:[{label:'Cat',description:'c'},{label:'Dog',description:'d'}]}];
test('the transcript enriches a card when it already recorded the matching tool call',async t=>{
 const dialog=new FakeDialog([{header:'Pet',question:'Which pet?',options:['Cat','Dog']}]);const {store,providers,id,write,attach}=providerFixture(t,dialog);
 write([ask('ask1',petQuestion)]);
 await providers.history(id);await providers.history(id);
 let pending=pendingQuestions(store,id);assert.equal(pending.length,1);assert.equal(pending[0].native,true);assert.equal(pending[0].terminal,true);assert.equal(pending[0].sourceToolId,'ask1');assert.equal(pending[0].readOnly,undefined);assert.equal(pending[0].questions[0].options[0].description,'c');
 const result=await providers.answer(id,pending[0].id,{'0':'Dog'});assert.deepEqual(result,{ok:true});
 assert.deepEqual(dialog.submitted,{'Which pet?':'Dog'});assert.equal(store.session(id).status,'running');
 assert.equal(pendingQuestions(store,id).length,0);assert.ok(store.messages(id).some(m=>m.role==='user'&&m.text.includes('Dog')));
 // The transcript lags behind the dialog; the handled question is not recreated meanwhile.
 await providers.history(id);assert.equal(pendingQuestions(store,id).length,0);
 write([ask('ask1',petQuestion),{type:'user',timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',tool_use_id:'ask1',content:'Dog'}]}}]);await providers.history(id);
 assert.equal(pendingQuestions(store,id).length,0);
 // A later question whose terminal ends is cancelled rather than left dangling.
 const second=attach(new FakeDialog([{header:'Pet',question:'Which pet?',options:['Cat','Dog']}]));
 write([ask('ask1',petQuestion),{type:'user',timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',tool_use_id:'ask1',content:'Dog'}]}},ask('ask2',petQuestion)]);await providers.history(id);
 pending=pendingQuestions(store,id);assert.equal(pending.length,1);assert.equal(pending[0].sourceToolId,'ask2');
 second.ended=true;await providers.history(id);assert.equal(pendingQuestions(store,id).length,0);
 await assert.rejects(providers.answer(id,pending[0].id,{'0':'Cat'}),/no longer pending/);
});
test('cards come from the screen when the transcript has not recorded the tool call yet',async t=>{
 const dialog=new FakeDialog([{header:'Pet',question:'Which pet?',options:['Cat','Dog']}]);const {store,providers,id}=providerFixture(t,dialog);
 await providers.history(id);
 const [card]=pendingQuestions(store,id);assert.ok(card);assert.equal(card.screen,true);assert.equal(card.terminal,true);assert.equal(card.sourceToolId,undefined);
 assert.equal(card.questions[0].title,'Which pet?');assert.deepEqual(card.questions[0].options,[{label:'Cat',description:'Cat description'},{label:'Dog',description:'Dog description'}]);assert.equal(card.questions[0].multiSelect,false);
 await providers.answer(id,card.id,{[card.questions[0].id]:'Dog'});
 assert.deepEqual(dialog.submitted,{'Which pet?':'Dog'});assert.equal(pendingQuestions(store,id).length,0);
 await providers.history(id);assert.equal(pendingQuestions(store,id).length,0);
});
test('a multi-question dialog is answered one visible question at a time from screen cards',async t=>{
 const dialog=new FakeDialog([{header:'Drink',question:'Which drink do you prefer?',options:['Tea','Coffee','Water']},{header:'Snacks',question:'Which snacks should I bring?',multiSelect:true,options:['Apples','Nuts','Chips']}]);
 const {store,providers,id}=providerFixture(t,dialog);
 await providers.history(id);let [card]=pendingQuestions(store,id);assert.equal(card.questions.length,1);assert.equal(card.questions[0].title,'Which drink do you prefer?');
 await providers.answer(id,card.id,{[card.questions[0].id]:'Coffee'});
 assert.equal(dialog.submitted,null,'must not submit before the second question');assert.equal(dialog.tab,1);assert.equal(pendingQuestions(store,id).length,0);
 await providers.history(id);[card]=pendingQuestions(store,id);assert.equal(card.questions[0].title,'Which snacks should I bring?');assert.equal(card.questions[0].multiSelect,true);
 await providers.answer(id,card.id,{[card.questions[0].id]:'Apples, Chips'});
 assert.deepEqual(dialog.submitted,{'Which drink do you prefer?':'Coffee','Which snacks should I bring?':'Apples, Chips'});
});
test('a dialog left at the review step offers a submit card',async t=>{
 const dialog=new FakeDialog([{header:'Drink',question:'Which drink?',options:['Tea','Coffee']},{header:'Size',question:'Which size?',options:['Small','Large']}]);
 dialog.questions[0].answer='Tea';dialog.questions[0].answered=true;dialog.questions[1].answer='Small';dialog.questions[1].answered=true;dialog.review=true;
 const {store,providers,id}=providerFixture(t,dialog);
 await providers.history(id);const [card]=pendingQuestions(store,id);assert.equal(card.review,true);assert.equal(card.questions[0].title,REVIEW_TITLE);assert.deepEqual(card.questions[0].options.map(o=>o.label),['Submit answers','Cancel']);
 await assert.rejects(providers.answer(id,card.id,{[card.questions[0].id]:'maybe'}),/Submit answers or Cancel/);
 await providers.answer(id,card.id,{[card.questions[0].id]:'Submit answers'});
 assert.deepEqual(dialog.submitted,{'Which drink?':'Tea','Which size?':'Small'});assert.deepEqual(dialog.writes,['1']);
});
test('screen cards are cancelled when the dialog changes or stays gone',async t=>{
 const dialog=new FakeDialog([{header:'Drink',question:'Which drink?',options:['Tea','Coffee']},{header:'Size',question:'Which size?',options:['Small','Large']}]);
 const {store,providers,id}=providerFixture(t,dialog);
 await providers.history(id);const [first]=pendingQuestions(store,id);assert.equal(first.questions[0].title,'Which drink?');
 dialog.write('\t');await providers.history(id);
 const [second]=pendingQuestions(store,id);assert.notEqual(second.id,first.id);assert.equal(second.questions[0].title,'Which size?');
 assert.equal(JSON.parse(store.db.prepare('SELECT data FROM questions WHERE id=?').get(first.id).data).state,'cancelled');
 dialog.cancelled=true;await providers.history(id);assert.equal(pendingQuestions(store,id).length,1,'a brief absence keeps the card');
 providers.dialogMissing.set(second.id,Date.now()-5000);await providers.history(id);assert.equal(pendingQuestions(store,id).length,0);
});
test('a failed terminal answer leaves the card pending and reports the problem',async t=>{
 const dialog=new FakeDialog([{header:'Pet',question:'Which pet?',options:['Cat','Dog']}]);const {store,providers,id,attach}=providerFixture(t,dialog);
 await providers.history(id);const [q]=pendingQuestions(store,id);
 const silent=attach({ended:false,writes:[],async lines(){return ['❯ '];},write(b){this.writes.push(b);}});
 const started=Date.now();
 await assert.rejects(providers.answer(id,q.id,{'0':'Dog'}),/not showing this question/);
 assert.ok(Date.now()-started<8000);assert.deepEqual(silent.writes,[]);assert.equal(pendingQuestions(store,id).length,1);assert.equal(store.session(id).status,'waiting');
});
