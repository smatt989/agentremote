import {writeFileSync,renameSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

// Local UI status only. Never put credentials, invitations, or session contents here.
export function desktopStatus(store,{port,relay='starting'}={}) {
  return {pid:process.pid,port,relay,updatedAt:Date.now(),
    activeSessions:store.listedSessions().filter(s=>s.external===false && ['running','submitting','waiting'].includes(s.status)).length,
    pairedDevices:store.db.prepare('SELECT COUNT(*) AS count FROM devices').get().count};
}
export function writeDesktopStatus(store,options) {
  const path=join(store.directory,'desktop-status.json');const temporary=path+'.'+process.pid;
  writeFileSync(temporary,JSON.stringify(desktopStatus(store,options)),{mode:0o600});renameSync(temporary,path);
}
export function clearDesktopStatus(store) {
  const path=join(store.directory,'desktop-status.json');
  try {if(JSON.parse(readFileSync(path,'utf8')).pid===process.pid)unlinkSync(path);}catch{}
}
