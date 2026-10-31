import {fixtureDirectory} from './fixture-directory.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir,homedir} from 'node:os';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';import {ClaudeTerminal} from '../desktop/src/claude-terminal.mjs';import {removeClaudeHistory} from '../desktop/src/providers.mjs';
const cwd=fixtureDirectory('ar-pty-smoke-'),id=randomUUID();
const t=new ClaudeTerminal({command:process.env.AGENT_REMOTE_CLAUDE||'claude',args:['--session-id',id,'--dangerously-skip-permissions'],cwd,helper:resolve('build/TerminalHost')});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const plain=()=>{const b=t.screen.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n');};
const input=(data,owner=t.owner,generation=t.generation)=>t.input({owner,generation,requestId:randomUUID(),data:Buffer.from(data).toString('base64')});
async function wait(check,label){for(let n=0;n<400;n++){await sleep(200);if(check(plain()))return;}throw Error(label+'\n'+plain().slice(-3500));}
try{
 await wait(s=>s.includes('trust')||s.includes('Claude Code'),'startup');await sleep(1200);
 if(/trust this folder/i.test(plain())){input('\x1b[B');await sleep(100);input('\r');await sleep(1200);}
 console.log('Claude PTY ready');
 input('\x1b[200~Remember the code word ORCHARD. Reply exactly FIRST_OK. Do not use tools.\x1b[201~');await sleep(200);input('\r');
 await wait(s=>/FIRST_OK/.test(s)&&/Remember the code word/.test(s),'first reply');await sleep(8000);
 const pid=t.child.pid;const old=t.generation;t.control('phone:test');
 assert.throws(()=>input('WRONG','desktop',old),/Control moved/);
 input('\x1b[200~What was the code word? Reply exactly PHONE_ORCHARD if you remember.\x1b[201~');await sleep(200);input('\r');
 await wait(s=>(s.match(/PHONE_ORCHARD/g)||[]).length>=2,'phone reply');console.log('Phone used same live Claude terminal and retained context');
 t.control('desktop');input('\x1b[200~What was the code word? Reply exactly DESKTOP_ORCHARD if you remember.\x1b[201~');await sleep(200);input('\r');
 await wait(s=>(s.match(/DESKTOP_ORCHARD/g)||[]).length>=2,'desktop reply');assert.equal(t.child.pid,pid);
 const frame=await t.read(0);assert.ok(frame.reset);assert.ok(Buffer.from(frame.data,'base64').toString().includes('DESKTOP_ORCHARD'));
 console.log('Desktop → phone → same desktop process passed; snapshot and ownership checks passed');
}finally{await t.close();removeClaudeHistory(join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'projects'),id);rmSync(cwd,{recursive:true,force:true});}
