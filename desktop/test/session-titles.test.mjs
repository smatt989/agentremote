import test from 'node:test';import assert from 'node:assert/strict';import {claudeSessionTitle} from '../src/providers.mjs';
const user=text=>({type:'user',message:{content:text}}),native=aiTitle=>({type:'ai-title',aiTitle});
test('generic managed Claude sessions gain the native generated title',()=>{
 assert.deepEqual(claudeSessionTitle({title:'Claude terminal session',external:false},[user('Help me understand our customer retention report'),native('Customer retention analysis')]),{title:'Customer retention analysis',titleSource:'native-auto'});
});
test('opening-message preview is stable and upgrades when the native title arrives',()=>{
 const preview=claudeSessionTitle({title:'New session'},[user('  Explain the retention\n metrics  ')]);assert.equal(preview.title,'Explain the retention metrics');
 assert.deepEqual(claudeSessionTitle(preview,[user('Thanks')]),preview);
 const named=claudeSessionTitle(preview,[native('Retention metric definitions')]);assert.equal(named.title,'Retention metric definitions');assert.deepEqual(claudeSessionTitle(named,[user('Thanks')]),named);
});
test('custom app and native names survive automatic titles and transcript tailing',()=>{
 assert.equal(claudeSessionTitle({title:'Board meeting',external:false},[native('AI title')]).title,'Board meeting');
 const custom=claudeSessionTitle({title:'Claude terminal session'},[{type:'custom-title',customTitle:'My report'},native('AI title')]);assert.equal(custom.title,'My report');assert.deepEqual(claudeSessionTitle(custom,[native('Another AI title')]),custom);
 assert.equal(claudeSessionTitle(custom,[{type:'custom-title',customTitle:'Renamed report'}]).title,'Renamed report');
});
test('internal metadata and tool results do not become a title',()=>{
 const rows=[{...user('Internal context'),isMeta:true},user('<local-command-stdout>hidden</local-command-stdout>'),{type:'user',message:{content:[{type:'tool_result',content:'secret'}]}},user('Find the analytics dashboard')];
 assert.equal(claudeSessionTitle(undefined,rows).title,'Find the analytics dashboard');
});
