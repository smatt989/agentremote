import {writeSync} from 'node:fs';

// Returning to the shell must undo emulator modes too, not just termios/raw mode.
// In particular a remotely killed CLI cannot run its own mouse cleanup.
export const terminalRestoreSequence = '\x1b[?2026l'
 + [9,1000,1001,1002,1003,1004,1005,1006,1015,1016,2004].map(mode=>'\x1b[?'+mode+'l').join('')
 + '\x1b[>4;0m\x1b[?1l\x1b>\x1b[?1049l\x1b[0m\x1b[0 q\x1b[?25h';

export function terminalCleanup(input=process.stdin,output=process.stdout){
 let restored=false;
 return ()=>{
  if(restored)return;restored=true;
  // Synchronous output: process.exit must not truncate these escape sequences.
  try{if(output.isTTY)writeSync(output.fd,terminalRestoreSequence);}catch{}
  try{if(input.isTTY)input.setRawMode(false);}catch{}
 };
}
