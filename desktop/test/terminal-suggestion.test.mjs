import test from 'node:test';import assert from 'node:assert/strict';import headless from '@xterm/headless';import {terminalPromptReady,terminalBlocked} from '../src/claude-terminal.mjs';
async function ready(text){const screen=new headless.Terminal({cols:80,rows:28,allowProposedApi:true});try{await new Promise(r=>screen.write(text,r));return terminalPromptReady(screen);}finally{screen.dispose();}}
test('empty prompt and dim Claude suggestion are sendable without accepting suggested text',async()=>{
 assert.equal(await ready('❯ \x1b[1;3H'),true);
 assert.equal(await ready('❯ \x1b[2mSuggested next question\x1b[0m\r\n───────────────────\r\nfooter\x1b[1;3H'),true);
 assert.equal(await ready('❯ \x1b[2m'+'Suggestion '.repeat(10)+'\x1b[0m\r\n───────────────────\x1b[1;3H'),true);
});
test('real drafts, draft plus suggestion, cursor inside text, and dialogs still block sending',async()=>{
 for(const text of ['❯ real draft\x1b[1;3H','❯ draft \x1b[2msuggestion\x1b[0m\x1b[1;9H','❯ \x1b[2msuggestion\x1b[0m\x1b[1;8H','❯ \r\nreal second line\r\n───────────────────\x1b[1;3H','❯ \x1b[2msuggestion\x1b[0m\r\nnot a wrapped suggestion\x1b[1;3H','Choose an option:'])assert.equal(await ready(text),false);
});
test('blocked sends name Claude dialogs instead of reporting a draft',async()=>{
 const reason=async text=>{const screen=new headless.Terminal({cols:80,rows:28,allowProposedApi:true});try{await new Promise(r=>screen.write(text,r));return terminalBlocked(screen);}finally{screen.dispose();}};
 assert.match(await reason(' Accessing workspace:\r\n\r\n /Users/me\r\n\r\n ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel\x1b[5;2H'),/trust this folder\. Answer the card/);
 assert.match(await reason(' Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\x1b[2;2H'),/waiting on a prompt\. Answer the card/);
 assert.match(await reason('❯ real draft\x1b[1;3H'),/has a draft/);
});
