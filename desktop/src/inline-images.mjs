import { statSync } from 'node:fs';
import { presentMessage } from './presentation.mjs';
const image = a => /^image\/(png|jpeg|gif|webp|heic|heif)$/.test(a.mime);
const decode = text => {try{return decodeURIComponent(text);}catch{return text;}};
// Associate registered session artifacts only. Never serve arbitrary paths found
// in model output. Whole-session placement keeps pagination stable.
// Placement reads every row of the session, so it is memoized per session revision and image set; the conversation
// is polled every second, and re-parsing a long session (17 MB of tool output) each time stalled the service.
const memo = new WeakMap(), MEMO_LIMIT = 32;
export function imagePlacements(store,id,artifacts) {
  const images=artifacts.filter(image);
  if(!images.length)return new Map();
  const key=store.sessionRevision?.(id)+'|'+JSON.stringify(images.map(a=>[a.id,a.name]));
  let cache=memo.get(store);if(!cache){cache=new Map();memo.set(store,cache);}
  const hit=cache.get(id);if(hit?.key===key)return hit.placements;
  // Only the fields placement needs, extracted in SQLite instead of parsing every row's JSON in JavaScript.
  const all=store.db.prepare(`SELECT id,json_extract(data,'$.role') AS role,json_extract(data,'$.kind') AS kind,json_extract(data,'$.partial') AS partial,
    json_extract(data,'$.completedAt') AS completedAt,json_extract(data,'$.createdAt') AS createdAt,json_extract(data,'$.attachments') AS attachments,CASE WHEN json_extract(data,'$.role')='tool' THEN NULL ELSE coalesce(json_extract(data,'$.text'),'') END AS text
    FROM messages WHERE session=? ORDER BY seq`).all(id);
  const responses=all.filter(m=>m.role==='assistant'&&m.kind==='text'&&m.partial!==1);
  const placements=new Map(),texts=all.map(m=>m.text===null?null:decode(String(m.text)));
  for(const a of images){
    // Subfolder files (storyboard/01.png) are usually batches: place one inline only where a reply names it by
    // relative path or file name; the rest stay under Files & charts instead of flooding a single reply.
    // A photo or file the user attached belongs on their own message, never under the agent's next reply: the one that
    // lists it, or (rows stored before attachments were recorded) the first user message sent after the upload.
    const file=store.db.prepare('SELECT path FROM artifacts WHERE id=? AND session=?').get(a.id,id);
    if(file&&file.path.split('/').at(-1)===`${a.id}-${a.name}`){
      let owner=all.find(m=>m.role==='user'&&m.attachments&&m.attachments.includes(a.id));
      if(!owner){let modified;try{modified=statSync(file.path).mtimeMs;}catch{continue;}owner=all.find(m=>m.role==='user'&&m.kind==='text'&&!m.attachments&&(m.createdAt||m.completedAt||0)>=modified-2000);}
      if(owner){const list=placements.get(owner.id)||[];list.push(a);placements.set(owner.id,list);}
      continue;
    }
    const nested=a.name.includes('/'),base=a.name.split('/').at(-1);
    const mentions=all.filter((m,i)=>texts[i]!==null&&(texts[i].includes(a.name)||(nested&&texts[i].includes(base))));
    let target=mentions.at(-1);
    if(!target){
      if(nested)continue;
      let modified;try{modified=statSync(file.path).mtimeMs;}catch{continue;}
      target=responses.find(m=>(m.completedAt||0)>=modified-2000)||responses.at(-1);
    }
    if(target){const list=placements.get(target.id)||[];list.push(a);placements.set(target.id,list);}
  }
  cache.delete(id);cache.set(id,{key,placements});
  if(cache.size>MEMO_LIMIT)cache.delete(cache.keys().next().value);
  return placements;
}
export function presentPage(page,placements) {
  return page.map(presentMessage).filter(Boolean).map(m=>({...m,...(placements.has(m.id)?{images:placements.get(m.id)}:{})}));
}
export function inlineImages(store,id,page,artifacts) {
  return presentPage(page,imagePlacements(store,id,artifacts));
}
