import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ClaudeTerminal} from '../src/claude-terminal.mjs';
const pause=()=>new Promise(r=>setTimeout(r,30));
test('real PTY and emulator retain launch cwd and agree on initial and changed dimensions',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'ar-size-'));
 const script=`import os,signal,tty
assert os.getcwd()==os.path.realpath(os.environ['EXPECTED_CWD'])
assert 'COLUMNS' not in os.environ and 'LINES' not in os.environ
tty.setraw(0)
def draw(*args):
 s=os.get_terminal_size(0)
 os.write(1, ('\\x1b[2J\\x1b[H'+str(s.columns)+'x'+str(s.lines)+'\\r\\n'+'x'*(s.columns+3)).encode())
signal.signal(signal.SIGWINCH,draw)
draw()
while True:
 b=os.read(0,1024)
 if not b: break
 os.write(1,b)
`;
 const terminal=new ClaudeTerminal({command:'/usr/bin/python3',args:['-u','-c',script],cwd,cols:95,rows:36,env:{...process.env,EXPECTED_CWD:cwd,COLUMNS:'80',LINES:'28'},helper:resolve('desktop/TerminalHost')});
 try{
  const wait=async expected=>{for(let i=0;i<100;i++){await pause();await terminal.pending;if(terminal.screen.buffer.active.getLine(0)?.translateToString(true)===expected)return;}assert.fail('PTY did not render '+expected);};
  await wait('95x36');const before=await terminal.read();assert.equal(before.cols,95);assert.equal(before.rows,36);
  assert.equal(terminal.screen.buffer.active.cursorX,3);assert.equal(terminal.screen.buffer.active.cursorY,2);
  assert.throws(()=>terminal.input({owner:'phone:test',resize:{cols:120,rows:45}}),/Only the desktop/);
  assert.throws(()=>terminal.resize(0,99999),/dimensions/);
  terminal.input({owner:'desktop',resize:{cols:120,rows:45}});await wait('120x45');
  const after=await terminal.read(before.seq);assert.equal(after.reset,true);assert.equal(after.cols,120);assert.equal(after.rows,45);
  assert.equal(terminal.screen.buffer.active.cursorX,3);assert.equal(terminal.screen.buffer.active.cursorY,2);
  terminal.input({owner:'desktop',requestId:'typing',data:Buffer.from('hello').toString('base64')});
  for(let i=0;i<100&&terminal.screen.buffer.active.cursorX!==8;i++)await pause();
  assert.equal(terminal.screen.buffer.active.cursorX,8);
  const channel=terminal.child.stdio[3];terminal.child.stdio[3]=undefined;
  try{terminal.resize(70,20);await wait('70x20');assert.equal(terminal.screen.buffer.active.cursorX,3);}finally{terminal.child.stdio[3]=channel;}
 }finally{await terminal.close();terminal.screen.dispose();rmSync(cwd,{recursive:true,force:true});}
});
