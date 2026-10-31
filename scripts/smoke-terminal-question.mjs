import {fixtureDirectory} from './fixture-directory.mjs';
// Real shared Claude terminal: a native AskUserQuestion becomes a question card and the
// card's answer is delivered by driving the dialog. Only disposable fixture state and a
// newly created session are used; the session and its transcript are removed afterwards.
import assert from 'node:assert/strict';
import {rmSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {join,resolve} from 'node:path';
import {Store} from '../desktop/src/store.mjs';
import {Providers} from '../desktop/src/providers.mjs';
import {terminalPromptReady} from '../desktop/src/claude-terminal.mjs';
import {pendingQuestions} from '../desktop/src/questions.mjs';
import {REVIEW_TITLE} from '../desktop/src/terminal-questions.mjs';
process.env.AGENT_REMOTE_PTY ||= resolve('desktop/TerminalHost');
const dir=fixtureDirectory('ar-terminal-question-');const store=new Store(join(dir,'state'));const providers=new Providers(store);
// A nested Claude session would disable transcript saving; the card is derived from the transcript.
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(CLAUDE|AI_AGENT)/.test(key)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let id,keep=false;
const plain=async()=>(await providers.terminals.get(id).lines()).join('\n');
const ready=async()=>{const host=providers.terminals.get(id);await host.pending;return terminalPromptReady(host.screen);};
async function waitPrompt(label){const end=Date.now()+90000;for(;;){if(await ready())return;if(Date.now()>end)throw Error(label+'\n'+(await plain()).slice(-2000));await sleep(250);}}
async function wait(check,label,ms=90000){const end=Date.now()+ms;for(;;){const s=await plain();if(check(s))return s;if(Date.now()>end)throw Error(label+'\n'+s.slice(-3000));await sleep(250);}}
async function pendingCard(){for(let n=0;n<60;n++){await providers.history(id);const q=pendingQuestions(store,id);if(q.length)return q[0];await sleep(500);}
 const session=store.session(id);const rows=session?.transcript&&existsSync(session.transcript)?readFileSync(session.transcript,'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean):[];
 const blocks=rows.flatMap(r=>Array.isArray(r.message?.content)?r.message.content:[]).filter(b=>b.type==='tool_result'||(b.type==='tool_use'&&b.name==='AskUserQuestion')).map(b=>b.type==='tool_use'?'use:'+b.id:'result:'+b.tool_use_id);
 const questions=store.db.prepare('SELECT data FROM questions WHERE session=?').all(id).map(r=>{const q=JSON.parse(r.data);return q.state+':'+q.sourceToolId;});
 const summary=rows.map(r=>r.type+':'+(Array.isArray(r.message?.content)?r.message.content.map(b=>b.type+(b.name?'('+b.name+')':'')).join('/'):typeof r.message?.content));const dirFiles=session?.transcript?readdirSync(dirname(session.transcript)):[];keep=true;
 throw Error('No question card appeared\nid: '+id+'\nrows: '+JSON.stringify(summary)+'\nproject files: '+JSON.stringify(dirFiles)+'\nsession: '+JSON.stringify({status:session?.status,control:session?.control,terminal:session?.terminal,transcript:session?.transcript,exists:session?.transcript&&existsSync(session.transcript)})+'\ntranscript blocks: '+JSON.stringify(blocks)+'\nquestions: '+JSON.stringify(questions)+'\nterminal ended: '+providers.terminals.get(id)?.ended);}
const type=async text=>{const host=providers.terminals.get(id);host.child.stdin.write('\x1b[200~'+text+'\x1b[201~');await sleep(300);host.child.stdin.write('\r');};
try{
 ({id}=await providers.startTerminal({command:process.env.AGENT_REMOTE_CLAUDE_BIN||join(process.env.HOME,'.local/bin/claude'),args:['--dangerously-skip-permissions','--model','haiku'],cwd:dir,env,cols:100,rows:40}));
 await wait(s=>/trust this folder|Claude Code/.test(s),'startup');await sleep(1000);
 if(/trust this folder/i.test(await plain())){providers.terminals.get(id).child.stdin.write('\x1b[B');await sleep(200);providers.terminals.get(id).child.stdin.write('\r');}
 await waitPrompt('prompt');await sleep(1500);
 // Answers by title so the check holds whether the card came from the transcript (all
 // questions at once) or from the screen (one visible question per card).
 const answerFor=title=>/drink/i.test(title)?'Coffee':/snack/i.test(title)?'Apples, Chips':/feeling/i.test(title)?'Sparkling green':/sides/i.test(title)?'Rice please':title===REVIEW_TITLE?'Submit answers':null;
 async function answerUntil(pattern,label){
  const seen=[];
  for(let n=0;n<6;n++){
   if(pattern.test(await plain()))return seen;
   const card=await pendingCard();const answers={};
   for(const item of card.questions){const value=answerFor(item.title);assert.ok(value,'unexpected question: '+item.title);answers[item.id]=value;}
   await providers.answer(id,card.id,answers);seen.push({source:card.screen?'screen':'transcript',review:!!card.review,titles:card.questions.map(q=>q.title)});
   assert.equal(store.session(id).status,'running');
   await wait(s=>pattern.test(s)||/Enter to select|Ready to submit/.test(s),label+' progress',60000);
  }
  await wait(s=>pattern.test(s),label);return seen;
 }
 await type('Use the AskUserQuestion tool now with exactly two questions. Question 1: header Drink, question: Which drink do you prefer?, single select, options: Tea, Coffee, Water. Question 2: header Snacks, question: Which snacks should I bring?, multiSelect true, options: Apples, Nuts, Chips. After I answer, reply exactly ROUND_ONE followed by my answers. Do not use any other tool.');
 await wait(s=>/Which drink do you prefer\?/.test(s)&&/Enter to select/.test(s),'first dialog');
 const first=await pendingCard();assert.equal(first.native,true);assert.equal(first.terminal,true);
 const detail=store.session(id);assert.equal(detail.control,'terminal');assert.equal(detail.terminal,true);
 const one=await answerUntil(/⏺\s*ROUND_ONE/,'first confirmation');
 const screen=await plain();assert.ok(/→\s*Coffee/.test(screen)&&/→\s*Apples, Chips/.test(screen),'answers echoed by the dialog summary');assert.ok(one.length>=1,'at least one card answered');
 for(let n=0;n<20&&pendingQuestions(store,id).length;n++){await providers.history(id);await sleep(500);}
 assert.equal(pendingQuestions(store,id).length,0);
 assert.equal(JSON.parse(store.db.prepare('SELECT data FROM questions WHERE id=?').get(first.id).data).state,'answered');
 console.log('Round one: option and multi-select answers reached the real dialog via',JSON.stringify(one));
 await waitPrompt('prompt again');await sleep(1500);
 await type('Use the AskUserQuestion tool again with exactly one question: header Mood, question: How are you feeling?, single select, options: Happy, Tired. After I answer, reply exactly ROUND_TWO followed by my answer. Do not use any other tool.');
 await wait(s=>/How are you feeling\?/.test(s)&&/Enter to select/.test(s),'second dialog');
 const two=await answerUntil(/⏺\s*ROUND_TWO/,'second confirmation');assert.ok(/→\s*Sparkling green/.test(await plain()));assert.equal(two.length,1);
 console.log('Round two: free-text answer reached the real single-question dialog via',JSON.stringify(two));
 await waitPrompt('prompt after round two');await sleep(1500);
 await type('Use the AskUserQuestion tool once more with exactly one question: header Sides, question: Which sides?, multiSelect true, options: Fries, Salad. After I answer, reply exactly ROUND_THREE followed by my answer. Do not use any other tool.');
 await wait(s=>/Which sides\?/.test(s)&&/Enter to select/.test(s),'third dialog');
 const three=await answerUntil(/⏺\s*ROUND_THREE/,'third confirmation');assert.ok(/→\s*Rice please/.test(await plain()));assert.equal(three.length,1);
 console.log('Round three: free-text answer reached the real lone multi-select dialog via',JSON.stringify(three));
}catch(e){
 if(id){const table=store.db.prepare('SELECT data FROM questions WHERE session=?').all(id).map(r=>{const q=JSON.parse(r.data);return {state:q.state,screen:!!q.screen,review:!!q.review,source:q.sourceToolId,titles:q.questions.map(i=>i.title)};});
  console.error('FAILURE DIAGNOSTICS\nquestions: '+JSON.stringify(table,null,1)+'\nsession: '+JSON.stringify({status:store.session(id)?.status})+'\nscreen:\n'+(await plain().catch(()=>'unavailable')).split('\n').filter(l=>l.trim()).slice(-40).join('\n'));}
 throw e;
}finally{
 if(id&&keep){await providers.stop(id,true).catch(e=>console.error('cleanup:',e.message));console.error('Transcript kept for inspection: '+store.session(id)?.transcript);}
 else if(id)await providers.remove(id).catch(e=>console.error('cleanup:',e.message));
 await providers.close();store.close();rmSync(dir,{recursive:true,force:true});
}
