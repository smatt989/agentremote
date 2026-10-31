import { readdirSync, lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { redact } from './memory.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

// Import only the provider's project reference folder. Never crawl the user's disk.
// These are fallible reference documents, not instructions or verified user facts.
export function importReferenceNotes(memory, session, root=join(homedir(),'.claude','projects')) {
  if(session.provider!=='claude'||!session.transcript||memory.store.deleted(session.id))return 0;
  let directory;
  try {
    const project=realpathSync(dirname(session.transcript)),base=realpathSync(root);
    if(dirname(project)!==base)return 0;
    directory=join(project,'memory');
    if(lstatSync(directory).isSymbolicLink()||realpathSync(directory)!==directory)return 0;
  }catch{return 0;}
  let count=0,budget=512000;
  for(const row of memory.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'reference-note:%'").all()) {
    const prior=JSON.parse(row.value);
    if(prior.path&&dirname(prior.path)===directory&&!existsSync(prior.path)) {
      memory.db.prepare("DELETE FROM memory_facts WHERE session=? AND json_extract(data,'$.sourceMessage')=?").run(prior.session,'reference:'+hash(prior.path));
      memory.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
      memory.exportSession(prior.session);count++;
    }
  }
  for(const name of readdirSync(directory).filter(n=>n.endsWith('.md')&&n!=='MEMORY.md').sort().slice(0,64)) {
    const path=join(directory,name);let stat,text;
    try {stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64000||stat.size>budget)continue;text=redact(readFileSync(path,'utf8'));budget-=stat.size;}catch{continue;}
    const key='reference-note:'+hash(path),signature=hash(text);
    const old=memory.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    const prior=old?JSON.parse(old.value):null;
    if(prior?.signature===signature)continue;
    // A reference has one stable owner across sessions in the same project.
    const owner=prior?.session||session.id,source='reference:'+hash(path);
    if(memory.store.deleted(owner)||memory.db.prepare('SELECT 1 FROM memory_hidden_sources WHERE session=? AND message=?').get(owner,source))continue;
    const topic='references/'+(name.replace(/\.md$/,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,65).replace(/-$/,'')||'note')+'-'+hash(directory).slice(0,8);
    memory.db.exec('BEGIN IMMEDIATE');
    try {
      memory.db.prepare("DELETE FROM memory_facts WHERE session=? AND json_extract(data,'$.sourceMessage')=?").run(owner,source);
      for(let offset=0;offset<text.length;offset+=1200) {
        const chunk=text.slice(offset,offset+1200),id=hash(source+'\n'+signature+'\n'+offset);
        const fact={id,topic,text:chunk,quote:chunk,sourceMessage:source,sourcePath:path,sourceSession:owner,kind:'reference',trust:'Agent-written reference note; verify against primary sources',createdAt:stat.mtimeMs,expiresAt:null};
        memory.db.prepare('INSERT INTO memory_facts VALUES(?,?,?,?)').run(id,owner,topic,JSON.stringify(fact));
      }
      memory.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify({session:owner,signature,path}));
      memory.db.exec('COMMIT');
    }catch(error){memory.db.exec('ROLLBACK');throw error;}
    memory.exportSession(owner);count++;
  }
  if(count)memory.store.knowledge?.refresh();return count;
}

export function evidenceText(message) {
  if(['user','assistant'].includes(message.role)&&message.kind==='text')return message.text||'';
  if(message.role!=='tool'||['sleep','imageView','imageGeneration','reasoning'].includes(message.kind))return '';
  // Do not feed image/base64 payloads, chain-of-thought, or recalled memory back into learning.
  let value;try{value=JSON.parse(message.text);}catch{return /command|output|result|function|tool/i.test(message.kind)?message.text||'':'';}
  const strip = (v) => {
    if(Array.isArray(v))return v.map(strip).filter(v=>v!==undefined);
    if(!v||typeof v!=='object')return v;
    if(['image','thinking','redacted_thinking','audio'].includes(v.type))return undefined;
    return Object.fromEntries(Object.entries(v).filter(([k])=>!['signature','thinking'].includes(k)).map(([k,v])=>[k,strip(v)]).filter(([,v])=>v!==undefined));
  };
  if(/memory_search|knowledge_read|knowledge_search|memory_topics/.test(value.name||value.tool||''))return '';
  return JSON.stringify(strip(value))||'';
}
