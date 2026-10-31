// Native AskUserQuestion dialogs inside a shared Claude terminal: read the rendered
// dialog into a question card and answer it by sending keys, verifying every step on
// the screen. Observed on Claude Code 2.1: digits select (single choice) or toggle
// (multiple choice) numbered options; the row after the real options is free text
// ("Type something"); multiple-choice questions end with a Submit/Next row; a lone
// single-choice question submits on selection, everything else finishes on a review
// tab whose first option submits all answers. Esc is never sent. Claude Code persists
// the tool call to the transcript at an unpredictable time, so the screen is the source
// of truth and the transcript only enriches a card when it already has the tool input.
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const FREE_TEXT=/^type something\.?$/i;
export const squash=text=>String(text||'').normalize('NFKC').replace(/[\s│┃|]+/g,'').toLowerCase();
const clean=text=>String(text).replaceAll('\x1b','').replace(/\r?\n/g,' ');
export const REVIEW_TITLE='Ready to submit your answers?';
export const REVIEW_OPTIONS=[{label:'Submit answers',description:'Send every answer in this dialog to Claude.'},{label:'Cancel',description:'Close the dialog without answering.'}];

// Parses the visible dialog. Returns null when no question dialog is on screen.
export function parseDialog(lines){
  const hint=lines.findLastIndex(line=>/Enter to select/.test(line));
  const review=lines.findLastIndex(line=>/Ready to submit your answers\?|You have not answered all questions/.test(line));
  if(review>=0&&review>hint){
    const numbered=lines.slice(review+1).map(line=>line.match(/^\s*(?:❯)?\s*(\d+)\.\s*(.*)$/)).filter(Boolean);
    const option=(pattern,fallback)=>Number(numbered.find(m=>pattern.test(m[2]))?.[1]||fallback);
    return {review:true,textMode:false,submitOption:option(/Submit answers/,1),cancelOption:option(/Cancel/,2),incomplete:lines.slice(Math.max(0,review-12),review+1).some(line=>/not answered all/i.test(line))};
  }
  if(hint<0)return null;
  let tabs=-1;for(let i=hint-1;i>=0;i--){if(/[☐☒]/.test(lines[i])){tabs=i;break;}}
  if(tabs<0)return null;
  const rows=[];const title=[];let next=1;
  for(let i=tabs+1;i<hint;i++){
    const line=lines[i];
    const numbered=line.match(/^\s*(❯)?\s*(\d+)\.\s*(?:\[([^\]])\]\s*)?(.*)$/);
    const action=line.match(/^\s*(❯)?\s*(Submit|Next)\s*$/);
    if(numbered&&Number(numbered[2])===next){next++;rows.push({number:next-1,highlighted:!!numbered[1],checked:numbered[3]===undefined?undefined:numbered[3].trim()!=='',label:numbered[4].trim(),details:[]});}
    else if(action&&rows.length)rows.push({action:action[2],highlighted:!!action[1]});
    else if(!rows.length){if(line.trim())title.push(line.replace(/^\s*[│┃|]\s?/,'').trim());}
    else if(line.trim()&&!/^[─━-]{3,}/.test(line.trim()))rows.at(-1).details?.push(line.trim());
  }
  const numbered=rows.filter(row=>row.number);
  return {
    review:false,multiTab:/[☐☒][^☐☒]*[☐☒]|Submit/.test(lines[tabs]),questionCount:(lines[tabs].match(/[☐☒]/g)||[]).length,
    title:squash(title.join('')),titleText:title.join(' ').replace(/\s+/g,' ').trim(),
    rows,highlight:rows.findIndex(row=>row.highlighted),textMode:/ctrl\+g/i.test(lines[hint]),
    multiSelect:numbered.some(row=>row.checked!==undefined),
    options:numbered.length>=3?numbered.slice(0,numbered.length-2).map(row=>({label:row.label,description:row.details.join(' ')})):[],
  };
}

// The question currently shown, in the shape createQuestion accepts. Multi-question
// dialogs yield one card per visible question; the review step yields a submit card.
export function screenQuestion(view){
  if(!view)return null;
  if(view.review)return {review:true,questions:[{question:REVIEW_TITLE,options:REVIEW_OPTIONS}]};
  if(!view.titleText||view.options.length<1)return null;
  return {review:false,questions:[{question:view.titleText,multiSelect:view.multiSelect,options:view.options}]};
}

// True when the transcript's tool input describes the dialog on screen.
export function matchesDialog(view,questions){
  if(!view)return false;
  if(view.review)return true;
  return (questions||[]).some(q=>view.title.includes(squash(q.question||q.title).slice(0,24)));
}

export function multiSelectChoice(item,text){
  const labels=item.options.map(option=>option.label.trim());
  const parts=String(text).split(', ').map(part=>part.trim()).filter(Boolean);
  return parts.length&&parts.every(part=>labels.includes(part))?new Set(parts):null;
}

export async function answerTerminalQuestion(terminal,question,answers,{poll=60,timeout=3000,settle=150}={}){
  const items=question.questions;
  const read=async()=>parseDialog(await terminal.lines());
  // A predicate must hold on two reads so a half-drawn frame is never mistaken for a state.
  const until=async(check,message,limit=timeout)=>{
    const end=Date.now()+limit;
    for(;;){
      const view=await read();
      if(check(view)){await sleep(settle);const again=await read();if(check(again))return again;}
      if(Date.now()>end)throw fail(message);
      await sleep(poll);
    }
  };
  const press=async(bytes,check,message,limit)=>{terminal.write(bytes);return until(check,message,limit);};
  const showing=(view,item)=>!!view&&!view.review&&view.title.includes(squash(item.title).slice(0,24));
  const layout=(view,item)=>{const numbered=view.rows.filter(row=>row.number);return numbered.length===item.options.length+2&&/chataboutthis/.test(squash(numbered.at(-1).label));};
  const check=`Check Terminal controls.`;
  if(terminal.ended)throw fail('This terminal has ended.');
  if(terminal.submittingPrompt)throw fail('A message is being submitted to this terminal. Try again shortly.');
  for(const item of items)if(typeof answers[item.id]!=='string'||!answers[item.id].trim())throw fail('Answer each question.',400);
  if(question.review){
    const choice=String(answers[items[0].id]).trim();
    if(!REVIEW_OPTIONS.some(option=>option.label===choice))throw fail('Choose Submit answers or Cancel.',400);
    const view=await until(v=>!!v&&v.review,'The terminal is no longer at the submit step. '+check);
    if(view.incomplete&&choice==='Submit answers')throw fail('Some questions in this dialog are still unanswered. '+check);
    await press(String(choice==='Cancel'?view.cancelOption:view.submitOption),v=>!v,'The dialog did not close. '+check);
    return {ok:true};
  }
  const leaveText=async view=>view.textMode?press('\x1b[A',v=>!!v&&!v.review&&!v.textMode,'Could not leave the text field in the terminal. '+check):view;
  const moveTo=async(view,target)=>{
    for(let n=0;n<16&&view.highlight!==target;n++){
      if(view.highlight<0)throw fail('Could not find the highlighted option in the terminal. '+check);
      const down=target>view.highlight;const next=view.highlight+(down?1:-1);
      view=await press(down?'\x1b[B':'\x1b[A',v=>!!v&&!v.review&&v.highlight===next,'Could not move the highlight in the terminal. '+check);
    }
    if(view.highlight!==target)throw fail('Could not move the highlight in the terminal. '+check);
    return view;
  };
  const clearText=async(view,row)=>{
    const label=view.rows[row]?.label||'';
    if(!label||FREE_TEXT.test(label))return view;
    const cleared=v=>!!v&&!v.review&&FREE_TEXT.test(v.rows[row]?.label||'');
    const attempt=await press('\x15',cleared,'',1000).catch(()=>null);
    if(attempt)return attempt;
    return press('\x7f'.repeat(((await read())?.rows[row]?.label||label).length+4),cleared,'Could not clear existing text in the terminal. '+check);
  };
  const typeInto=async(view,row,text)=>{
    view=await clearText(view,row);
    const expected=squash(text).slice(0,24);
    return press('\x1b[200~'+clean(text)+'\x1b[201~',v=>!!v&&!v.review&&squash(v.rows[row]?.label||'').startsWith(expected),'The typed answer did not appear in the terminal. '+check);
  };
  const navigate=async(item,index)=>{
    let view=await until(v=>!!v,'The terminal is not showing this question right now. '+check);
    for(let n=0;n<items.length*2+3;n++){
      if(showing(view,item))return view;
      if(view.review){view=await press('\x1b[Z',v=>!!v&&!v.review,'Could not move between questions in the terminal. '+check);continue;}
      if(!view.multiTab)throw fail('The terminal is showing a different question. '+check);
      view=await leaveText(view);
      const current=items.findIndex(candidate=>showing(view,candidate));
      const before=view.title;
      view=await press(current>index?'\x1b[Z':'\t',v=>!!v&&(v.review||v.title!==before),'Could not move between questions in the terminal. '+check);
    }
    throw fail('Could not reach this question in the terminal. '+check);
  };
  const single=async(view,item)=>{
    if(!layout(view,item))throw fail('The terminal question layout was not recognized. '+check);
    view=await leaveText(view);
    const text=String(answers[item.id]);
    const title=view.title;const moved=v=>!v||v.review||v.title!==title;
    const option=item.options.findIndex(candidate=>candidate.label.trim()===text.trim());
    if(option>=0){
      const before=JSON.stringify(view);
      terminal.write(String(option+1));
      view=await until(v=>moved(v)||JSON.stringify(v)!==before,'',1000).catch(()=>undefined);
      if(view===undefined)view=await read();
      if(moved(view))return view;
      if(view.highlight===option)return press('\r',moved,'The selection was not accepted in the terminal. '+check);
      throw fail('The option was not selected in the terminal. '+check);
    }
    const row=item.options.length;
    view=await press(String(row+1),v=>!!v&&!v.review&&v.textMode&&v.highlight===row,'Could not open the text field in the terminal. '+check);
    view=await typeInto(view,row,text);
    return press('\r',moved,'The typed answer was not accepted in the terminal. '+check);
  };
  const multiple=async(view,item)=>{
    if(!layout(view,item))throw fail('The terminal question layout was not recognized. '+check);
    view=await leaveText(view);
    const text=String(answers[item.id]);const chosen=multiSelectChoice(item,text);
    const row=item.options.length;const action=view.rows.findIndex(candidate=>candidate.action);
    if(action<0)throw fail('The terminal question layout was not recognized. '+check);
    for(let k=0;k<item.options.length;k++){
      const want=!!chosen&&chosen.has(item.options[k].label.trim());
      if(!!view.rows[k].checked===want)continue;
      view=await press(String(k+1),v=>!!v&&!v.review&&!v.textMode&&!!v.rows[k]?.checked===want,'Could not toggle an option in the terminal. '+check);
    }
    if(chosen){
      if(view.rows[row].checked)view=await press(String(row+1),v=>!!v&&!v.review&&!v.rows[row]?.checked,'Could not clear the typed option in the terminal. '+check);
    } else {
      view=await moveTo(view,row);
      view=await typeInto(view,row,text);
      if(!view.rows[row].checked)view=await press('\r',v=>!!v&&!v.review&&!!v.rows[row]?.checked,'The typed answer was not selected in the terminal. '+check);
    }
    view=await moveTo(view,action);
    const title=view.title;
    return press('\r',v=>!v||v.review||v.title!==title,'The selections were not accepted in the terminal. '+check);
  };
  for(const [index,item] of items.entries()){
    const view=await navigate(item,index);
    if(item.multiSelect)await multiple(view,item);else await single(view,item);
  }
  // A card built from the screen covers one question of a possibly longer dialog: stop
  // once the dialog moved on, and submit only when the review step is reached.
  const partial=!!question.screen;
  const view=await until(v=>!v||v.review||(partial&&!items.some(item=>showing(v,item))),'The answers did not reach the submit step. '+check);
  if(view?.review){
    if(view.incomplete)throw fail('Some questions in this dialog are still unanswered. '+check);
    await press(String(view.submitOption),v=>!v,'The answers were not submitted. '+check);
  }
  return {ok:true};
}

// Claude Code's other selection dialogs: folder trust after a restart, tool permission
// prompts, MCP approvals and confirmations. They share one shape: a ❯-highlighted list
// of options above an "Enter to confirm · Esc to cancel" hint. Returns null otherwise,
// including for AskUserQuestion dialogs, which parseDialog handles.
const CHOICE_HINT=/Enter to (confirm|continue)|Esc to (cancel|exit)/i;
export function parseChoiceDialog(lines){
  const hint=lines.findLastIndex(line=>CHOICE_HINT.test(line));
  if(hint<0||parseDialog(lines))return null;
  // A live prompt is the last thing on screen; the same words quoted in output have the input box below them.
  const after=lines.slice(hint+1).filter(line=>line.trim());if(after.length>3||after.some(line=>/❯/.test(line)))return null;
  let top=0;for(let i=hint-1;i>=0;i--)if(/^\s*[─━]{3,}/.test(lines[i])){top=i+1;break;}
  const marked=lines.slice(top,hint).findIndex(line=>/^\s*❯\s*\S/.test(line));
  if(marked<0)return null;
  const at=top+marked;const column=lines[at].search(/❯/);const label=lines[at].match(/^\s*❯\s*/)[0].length;
  // Option rows start at the label column (the marker sits in the gutter); deeper rows are details.
  const row=line=>{const m=line.match(/^(\s*)(❯\s*)?(\S.*)$/);if(!m)return null;const start=m[1].length+(m[2]||'').length;return start===label&&(m[2]?m[1].length===column:true)?{highlighted:!!m[2],text:m[3].trim()}:start>label?{detail:m[3].trim()}:null;};
  let first=at;while(first>top&&row(lines[first-1])&&!row(lines[first-1]).detail)first--;
  const options=[];let highlight=-1;
  for(let i=first;i<hint;i++){
    const r=row(lines[i]);if(!r){if(lines[i].trim())break;continue;}
    if(r.detail){if(options.length)options.at(-1).details.push(r.detail);continue;}
    if(r.highlighted)highlight=options.length;
    options.push({label:r.text.replace(/^\d+\.\s*/,''),details:[]});
  }
  if(options.length<2||options.length>6||highlight<0||options.some(o=>FREE_TEXT.test(o.label)))return null;
  const titleText=lines.slice(top,first).map(line=>line.replace(/^\s*[│┃|]\s?/,'').trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim().slice(-900);
  if(!titleText)return null;
  return {titleText,options:options.map(o=>({label:o.label.slice(0,160),description:o.details.join(' ').slice(0,400)})),highlight,
    key:squash(titleText).slice(0,200)+'|'+options.map(o=>squash(o.label)).join('|')};
}

// Answers a choice dialog by moving the highlight with arrow keys and pressing Enter,
// verifying every step on screen. Digits are not used: some dialogs act on them at once.
export async function answerChoiceDialog(terminal,question,answers,{poll=60,timeout=3000,settle=150}={}){
  const read=async()=>parseChoiceDialog(await terminal.lines());
  const until=async(check,message)=>{
    const end=Date.now()+timeout;
    for(;;){
      const view=await read();
      if(check(view)){await sleep(settle);const again=await read();if(check(again))return again;}
      if(Date.now()>end)throw fail(message);
      await sleep(poll);
    }
  };
  const check='Check Terminal controls.';
  if(terminal.ended)throw fail('This terminal has ended.');
  if(terminal.submittingPrompt)throw fail('A message is being submitted to this terminal. Try again shortly.');
  const item=question.questions[0];const choice=String(answers[item.id]||'').trim();
  const target=item.options.findIndex(option=>option.label.trim()===choice);
  if(target<0)throw fail('Choose one of the options.',400);
  const same=view=>!!view&&view.key===question.dialogKey;
  let view=await until(same,'The terminal is no longer showing this prompt. '+check);
  for(let n=0;n<8&&view.highlight!==target;n++){
    const next=view.highlight+(target>view.highlight?1:-1);
    terminal.write(target>view.highlight?'\x1b[B':'\x1b[A');
    view=await until(v=>same(v)&&v.highlight===next,'Could not move the highlight in the terminal. '+check);
  }
  if(view.highlight!==target)throw fail('Could not move the highlight in the terminal. '+check);
  terminal.write('\r');
  await until(v=>!same(v),'The terminal did not accept the choice. '+check);
  return {ok:true};
}
