import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalInputFilter} from '../src/terminal-input.mjs';
test('mirrored terminal replies and focus events are suppressed across chunks',()=>{
 const f=new TerminalInputFilter();
 for(const reply of ['\x1b[12;30R','\x1b[?1;2c','\x1b[>0;95;0c','\x1b[?1u','\x1b]11;rgb:0000/0000/0000\x1b\\','\x1bP1$r0m\x1b\\','\x1b[I','\x1b[O'])for(const byte of Buffer.from(reply))assert.equal(f.write(Buffer.from([byte])).length,0);
 assert.equal(f.write(Buffer.from('hello')).toString(),'hello');
});
test('real keys, UTF-8, paste and escape survive filtering',()=>{
 const f=new TerminalInputFilter();const keys='Hi 👋\x1b[A\x1b[B\x1b[15~\x03\x1d\r';let output='';const pieces=[];
 for(const byte of Buffer.from(keys))pieces.push(f.write(Buffer.from([byte])));
 assert.equal(Buffer.concat(pieces).toString(),keys);
 const paste='\x1b[200~literal \x1b[12;30R\n🙂\x1b[201~';const chunks=[];for(const byte of Buffer.from(paste))chunks.push(f.write(Buffer.from([byte])));assert.equal(Buffer.concat(chunks).toString(),paste);
 assert.equal(f.write(Buffer.from('\x1b')).length,0);assert.equal(f.flushEscape().toString(),'\x1b');
});
