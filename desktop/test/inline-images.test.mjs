import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Store} from '../src/store.mjs';import {inlineImages} from '../src/inline-images.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'ar-inline-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.save({id:'s'});return {dir,store};}
test('registered image links attach to the correct message and preserve raw history',t=>{
 const {store,dir}=fixture(t);const file=join(dir,'slide one.png');writeFileSync(file,'png');const a={id:'image',name:'slide one.png',mime:'image/png'};store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(a.id,'s',a.name,file,a.mime);
 const text='Here it is: ![Slide](</some/path/slide%20one.png>)';store.message('s',{id:'m',role:'assistant',kind:'text',text});store.message('s',{id:'later',role:'assistant',kind:'text',text:'Another thing'});
 const rendered=inlineImages(store,'s',store.messages('s'),[a]);assert.equal(rendered[0].images[0].id,'image');assert.equal(rendered[1].images,undefined);assert.equal(store.messages('s')[0].text,text);
});
test('unlinked generated slides attach to the response after their creation, consistently across pages',t=>{
 const {store,dir}=fixture(t);const file=join(dir,'slide.png');writeFileSync(file,'png');const a={id:'image',name:'slide.png',mime:'image/png'};store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(a.id,'s',a.name,file,a.mime);
 store.message('s',{id:'before',role:'assistant',kind:'text',text:'Working',completedAt:Date.now()-60000});store.message('s',{id:'done',role:'assistant',kind:'text',text:'The four slides are ready',completedAt:Date.now()+1000});store.message('s',{id:'later',role:'assistant',kind:'text',text:'Other work',completedAt:Date.now()+60000});
 const page=store.messages('s');assert.equal(inlineImages(store,'s',page,[a])[1].images.length,1);assert.equal(inlineImages(store,'s',[page[2]],[a])[0].images,undefined);
});
test('subfolder images go inline only where a reply names them; the rest stay in the file list',t=>{
 const {store,dir}=fixture(t);const add=(id,name)=>{const file=join(dir,id+'.png');writeFileSync(file,'png');store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(id,'s',name,file,'image/png');return {id,name,mime:'image/png'};};
 const sheet=add('sheet','storyboard/storyboard.png'),frame=add('frame','storyboard/01.png');
 store.message('s',{id:'done',role:'assistant',kind:'text',text:'Open `storyboard.png` for all frames.',completedAt:Date.now()+1000});
 const rendered=inlineImages(store,'s',store.messages('s'),[sheet,frame]);assert.deepEqual(rendered[0].images.map(i=>i.id),['sheet']);
});
test('a photo the user attached shows on their own message, not under the next reply',t=>{
 const {store,dir}=fixture(t);const add=id=>{const name=`photo-${id}.jpg`,file=join(dir,`${id}-${name}`);writeFileSync(file,'jpg');store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(id,'s',name,file,'image/jpeg');return {id,name,mime:'image/jpeg'};};
 const listed=add('listed'),legacy=add('legacy');
 store.message('s',{id:'ask',role:'user',kind:'text',text:'What is in this?',attachments:['listed'],createdAt:Date.now()});
 store.message('s',{id:'old',role:'user',kind:'text',text:'And this one?',createdAt:Date.now()+500});
 store.message('s',{id:'reply',role:'assistant',kind:'text',text:'A screenshot.',completedAt:Date.now()+1000});
 const rendered=inlineImages(store,'s',store.messages('s'),[listed,legacy]);
 assert.deepEqual(rendered[0].images.map(i=>i.id),['listed']);assert.deepEqual(rendered[1].images.map(i=>i.id),['legacy']);assert.equal(rendered[2].images,undefined);
});
