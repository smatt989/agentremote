// Terminal picker for continuing an Agent Remote conversation in Terminal.
import {existsSync,statSync} from 'node:fs';
import {basename,dirname} from 'node:path';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline/promises';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDirectory=path=>{try{return statSync(path).isDirectory();}catch{return false;}};
// Claude stores a transcript under its project directory with every non-alphanumeric replaced.
const claudeProject=path=>path.replace(/[^A-Za-z0-9]/g,'-');

// Same order as the phone list: latest completed message first.
const when=s=>s.lastCompletedAt||s.updatedAt||0;
export function recentSessions(sessions,provider) {
 return sessions.filter(s=>['claude','codex'].includes(s.provider)&&s.providerId&&(!provider||s.provider===provider))
  .sort((a,b)=>when(b)-when(a));
}
export function matchSessions(list,query) {
 const q=query.trim().toLowerCase();if(!q)return list;
 const exact=list.filter(s=>s.providerId.toLowerCase()===q||s.id.toLowerCase()===q);if(exact.length)return exact;
 const prefix=list.filter(s=>q.length>=6&&s.providerId.toLowerCase().startsWith(q));if(prefix.length)return prefix;
 const words=q.split(/\s+/);
 return list.filter(s=>{const text=((s.title||'')+' '+(s.cwd||'')).toLowerCase();return words.every(w=>text.includes(w));});
}
// The directory Claude needs for resume: the stored cwd, or its nearest ancestor that owns the transcript.
export function sessionDirectory(session,fallback=homedir()) {
 const cwd=typeof session.cwd==='string'&&session.cwd.startsWith('/')?session.cwd:undefined;
 if(session.provider==='claude'&&session.transcript){
  const project=basename(dirname(session.transcript));
  for(let path=cwd;path;path=path==='/'?undefined:dirname(path))if(claudeProject(path)===project&&isDirectory(path))return path;
 }
 return cwd&&isDirectory(cwd)?cwd:fallback;
}
export function resumeArgs(session) {
 return session.provider==='claude'?['--resume',session.providerId]:['resume',session.providerId];
}
const age=ms=>{const m=Math.max(0,Math.round((Date.now()-ms)/60000));return m<1?'now':m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d';};
const short=path=>{const home=homedir();return !path?'':path===home?'~':path.startsWith(home+'/')?'~'+path.slice(home.length):path;};
const fit=(text,width)=>{const clean=String(text||'Untitled').replace(/\s+/g,' ').trim();return clean.length>width?clean.slice(0,width-1)+'…':clean.padEnd(width);};
export function formatSessions(list,width=100) {
 const titleWidth=Math.max(20,Math.min(60,width-38));
 const place=s=>{const text=(s.provider==='codex'?'codex ':'')+short(sessionDirectory(s,s.cwd));return (text.length>22?'…'+text.slice(-21):text).padEnd(22);};
 return list.map((s,i)=>`${String(i+1).padStart(3)}  ${fit(s.title,titleWidth)}  ${place(s)}  ${age(when(s)).padStart(4)}${['running','submitting','waiting'].includes(s.status)?'  (replying)':''}`).join('\n');
}
// Returns the chosen session, or undefined when cancelled or nothing matches.
export async function pickSession(sessions,{query='',provider,input=process.stdin,output=process.stderr,limit=20}={}) {
 const all=recentSessions(sessions,provider);
 if(uuid.test(query.trim()))return all.find(s=>s.providerId.toLowerCase()===query.trim().toLowerCase())||{provider:provider||'claude',providerId:query.trim()};
 const found=matchSessions(all,query);
 if(!found.length){output.write(query?`No Agent Remote conversation matches "${query}".\n`:'No Agent Remote conversations yet.\n');return;}
 if(query&&found.length===1)return found[0];
 const list=found.slice(0,limit);
 output.write(formatSessions(list,output.columns||100)+'\n');
 const rl=createInterface({input,output});
 try{
  for(;;){
   const answer=(await rl.question('Pick a number to continue (Enter to cancel): ')).trim();
   if(!answer)return;
   const n=Number(answer);if(Number.isInteger(n)&&n>=1&&n<=list.length)return list[n-1];
   const narrowed=matchSessions(list,answer);if(narrowed.length===1)return narrowed[0];
   output.write(`Choose 1–${list.length}.\n`);
  }
 }finally{rl.close();}
}
