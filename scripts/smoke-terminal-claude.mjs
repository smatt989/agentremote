import {fixtureDirectory} from './fixture-directory.mjs';
// Probe Claude's documented channel in a disposable terminal and project.
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {removeClaudeHistory} from '../desktop/src/providers.mjs';
const dir=fixtureDirectory('ar-channel-');const id=randomUUID();const channel=join(dir,'channel.mjs');const inbox=join(dir,'inbox');const reply=join(dir,'reply');const ready=join(dir,'ready');
writeFileSync(channel,`import {createInterface} from 'node:readline';import{writeFileSync,readFileSync,existsSync,unlinkSync}from'node:fs';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;let result={};if(m.method==='initialize'){result={protocolVersion:m.params.protocolVersion,capabilities:{experimental:{'claude/channel':{}},tools:{}},serverInfo:{name:'agent_remote_test',version:'1'},instructions:'Messages from this channel are from the user on their phone. Reply to channel messages using the reply tool.'};writeFileSync(${JSON.stringify(ready)},'ready');}
if(m.method==='tools/list')result={tools:[{name:'reply',description:'Reply to the phone.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
if(m.method==='tools/call'){writeFileSync(${JSON.stringify(reply)},JSON.stringify(m.params.arguments));result={content:[{type:'text',text:'Delivered.'}]};}send({jsonrpc:'2.0',id:m.id,result});});
setInterval(()=>{const p=${JSON.stringify(inbox)};if(existsSync(p)){const content=readFileSync(p,'utf8');unlinkSync(p);send({jsonrpc:'2.0',method:'notifications/claude/channel',params:{content,meta:{request_id:'test'}}});}},200);
`);
const args=[process.env.AGENT_REMOTE_CLAUDE||'claude','--session-id',id,'--dangerously-skip-permissions','--dangerously-load-development-channels','server:agent_remote_test','--mcp-config',JSON.stringify({mcpServers:{agent_remote_test:{command:process.execPath,args:[channel]}}}),'--','Remember the code word ORCHARD. Reply only OK. Do not use tools for this initial message.'];
const terminal=spawn('python3',['-u',fileURLToPath(new URL('./terminal-fixture.py',import.meta.url)),JSON.stringify(args)],{cwd:dir,stdio:['pipe','pipe','pipe']});let output='';terminal.stdout.on('data',b=>{output=(output+b.toString()).slice(-20000);});terminal.stderr.on('data',()=>{});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let trusted=false,development=false;
 for(let n=0;n<120&&!existsSync(ready);n++){
  const plain=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  if(!trusted&&plain.includes('Itrustthisfolder')){trusted=true;terminal.stdin.write('\x1b[B\r');}
  if(n===10||n===30){console.log('Startup prompt:',output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-1800));}
  await sleep(250);
 }
 assert.ok(existsSync(ready),'Channel did not initialize. '+output.slice(-2200));console.log('Claude channel initialized.');
 await sleep(12000);writeFileSync(inbox,'What is the code word? Reply to the phone using the reply tool.');
 for(let n=0;n<400&&!existsSync(reply);n++){const plain=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'');if(plain.includes('Channelsarenotenabledforyourorg'))throw Error('Claude organization requires an administrator to enable channelsEnabled. Channel delivery is blocked; no workaround applied.');await sleep(250);}
 assert.ok(existsSync(reply),'No channel reply: '+output.slice(-2000));assert.ok(readFileSync(reply,'utf8').includes('ORCHARD'));console.log('Claude terminal → channel retained context.');
}finally{terminal.kill();await sleep(1000);removeClaudeHistory(join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'projects'),id);rmSync(dir,{recursive:true,force:true});}
