import {StringDecoder} from 'node:string_decoder';

// A terminal viewing a mirrored screen answers its queries too. The host's
// emulator already answers them; forwarding duplicates corrupts native input.
export class TerminalInputFilter {
  decoder=new StringDecoder('utf8'); pending=''; pasted=false;
  write(data) {
    this.pending+=this.decoder.write(Buffer.isBuffer(data)?data:Buffer.from(data));
    let output='';
    while(this.pending){
      if(this.pasted){
        const end=this.pending.indexOf('\x1b[201~');
        if(end>=0){output+=this.pending.slice(0,end+6);this.pending=this.pending.slice(end+6);this.pasted=false;continue;}
        let keep=0;for(let n=1;n<6;n++)if(this.pending.endsWith('\x1b[201~'.slice(0,n)))keep=n;
        output+=this.pending.slice(0,this.pending.length-keep);this.pending=this.pending.slice(this.pending.length-keep);break;
      }
      if(this.pending[0]!=='\x1b'){const end=this.pending.indexOf('\x1b');if(end<0){output+=this.pending;this.pending='';break;}output+=this.pending.slice(0,end);this.pending=this.pending.slice(end);continue;}
      if(this.pending.length===1)break;
      let sequence;
      if(this.pending[1]==='['){
        sequence=this.pending.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
        if(!sequence){if(this.pending.length<4096)break;this.pending='';break;}
        this.pending=this.pending.slice(sequence.length);
        if(sequence==='\x1b[200~'){this.pasted=true;output+=sequence;continue;}
        if(/^\x1b\[[?>=]?[0-9;:]*[Rcnt]$/.test(sequence)||/^\x1b\[\?[0-9;:]*u$/.test(sequence)||/^\x1b\[[IO]$/.test(sequence))continue;
      }else if([']','P','_','^'].includes(this.pending[1])){
        sequence=this.pending.match(/^\x1b[\]P_^][\s\S]*?(?:\x07|\x1b\\)/)?.[0];
        if(!sequence){if(this.pending.length>16384)this.pending='';break;}
        this.pending=this.pending.slice(sequence.length);continue;
      }else{sequence=this.pending.slice(0,2);this.pending=this.pending.slice(2);}
      output+=sequence;
    }
    return Buffer.from(output);
  }
  flushEscape(){if(this.pending==='\x1b'){this.pending='';return Buffer.from('\x1b');}return Buffer.alloc(0);}
}

export function filterTerminalInput(stream,listener){
  const filter=new TerminalInputFilter();let timer;
  const receive=data=>{clearTimeout(timer);const clean=filter.write(data);if(clean.length)listener(clean);timer=setTimeout(()=>{const tail=filter.flushEscape();if(tail.length)listener(tail);},35);timer.unref?.();};
  stream.on('data',receive);
  return ()=>{clearTimeout(timer);stream.off('data',receive);};
}
