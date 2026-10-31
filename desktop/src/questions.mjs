import { randomUUID } from 'node:crypto';
const fail=(text,status=400)=>Object.assign(new Error(text),{status});
export function initQuestions(db) { db.exec('CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,session TEXT NOT NULL,data TEXT NOT NULL)'); }
export function createQuestion(store,session,items,extra={}) {
  if(!store.session(session)||store.deleted(session))throw fail('Session unavailable.',404);
  if(!Array.isArray(items)||items.length<1||items.length>4)throw fail('Ask one to four questions.');
  const questions=items.map((q,i)=>{
    const title=q.title||q.question;if(typeof title!=='string'||!title.trim()||title.length>1000)throw fail('Invalid question.');
    const options=(q.options||[]).map(o=>typeof o==='string'?{label:o}:o);
    if(options.length>6||options.some(o=>!o||typeof o.label!=='string'||!o.label.trim()||o.label.length>160||o.description&&typeof o.description!=='string'))throw fail('Invalid options.');
    return {id:String(q.id||i),title,multiSelect:q.multiSelect===true,options:options.map(o=>({label:o.label,description:(o.description||'').slice(0,400)}))};
  });
  if(new Set(questions.map(q=>q.id)).size!==questions.length)throw fail('Question IDs must be unique.');
  const existing=pendingQuestions(store,session);if(existing.length)throw fail('Wait for the existing question to be answered.',409);
  const value={id:randomUUID(),questions,state:'pending',createdAt:Date.now(),...extra};
  store.db.prepare('INSERT INTO questions VALUES(?,?,?)').run(value.id,session,JSON.stringify(value));return value;
}
export function pendingQuestions(store,session) {return store.db.prepare('SELECT data FROM questions WHERE session=? ORDER BY rowid').all(session).map(r=>JSON.parse(r.data)).filter(q=>q.state==='pending');}
export function questionAnswer(store,session,id,answers) {
  const row=store.db.prepare('SELECT data FROM questions WHERE id=? AND session=?').get(id,session);if(!row)throw fail('Question no longer available.',404);
  const question=JSON.parse(row.data);
  if(!answers||typeof answers!=='object'||Array.isArray(answers))throw fail('Provide an answer.');
  const result={};for(const q of question.questions){const text=answers[q.id];if(typeof text!=='string'||!text.trim()||text.length>6000)throw fail('Answer each question.');result[q.id]=text.trim();}
  if(question.state==='answered') {if(JSON.stringify(question.answers)!==JSON.stringify(result))throw fail('Already answered differently.',409);return {question,duplicate:true};}
  if(question.state!=='pending')throw fail('This question is no longer pending.',409);
  return {question,answers:result,text:question.questions.map(q=>q.title+'\n'+result[q.id]).join('\n\n')};
}
export function resolveQuestion(store,question,answers,state='answered') { store.db.prepare('UPDATE questions SET data=? WHERE id=?').run(JSON.stringify({...question,state,answers}),question.id); }
export function cancelQuestions(store,session) {for(const q of pendingQuestions(store,session))resolveQuestion(store,q,undefined,'cancelled');}
