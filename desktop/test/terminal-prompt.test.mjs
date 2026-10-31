import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import headless from '@xterm/headless';
const html=readFileSync(new URL('../../ios/AgentRemote/TerminalAssets/index.html',import.meta.url),'utf8');const code=html.slice(html.indexOf('function dimensions('),html.lastIndexOf('</script>'));
async function state(text){const term=new headless.Terminal({cols:80,rows:28,allowProposedApi:true});const window={};new Function('window','term','document',code)(window,term,{getElementById:()=>({style:{}})});try{return await window.applyFrame({reset:true,data:Buffer.from(text).toString('base64')});}finally{term.dispose();}}
test('phone composer recognizes a blank native prompt, including nonbreaking spaces and footer',async()=>{assert.equal((await state('\x1b[H❯\u00a0\r\n────────────────────\r\n permissions footer\x1b[1;3H')).ready,true);});
test('phone composer protects desktop drafts, native approvals and multiline input',async()=>{
 for(const text of ['❯ unfinished draft','Choose an option:','❯ \r\nsecond line of draft\r\n────────────────────\x1b[1;3H'])assert.equal((await state(text)).ready,false);
});
