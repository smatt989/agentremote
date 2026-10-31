# PTY for disposable test sessions only; never attaches to an existing user terminal.
import os,pty,sys,select,json,fcntl,termios,struct,signal
pid,fd=pty.fork()
if pid==0:
    os.environ['TERM']='xterm-256color'
    args=json.loads(sys.argv[1]);os.execvp(args[0],args)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',45,120,0,0))
def stop(*args):
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM,stop)
while True:
    ready,_,_=select.select([fd,sys.stdin],[],[],1)
    if fd in ready:
        try: data=os.read(fd,65536)
        except OSError: break
        if not data: break
        if b'\x1b[6n' in data: os.write(fd,b'\x1b[1;1R')
        sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
    if sys.stdin in ready:
        data=os.read(sys.stdin.fileno(),65536)
        if data: os.write(fd,data)
