// Private pipe <-> PTY bridge. No shell interpolation; the child owns a session.
#include <util.h>
#include <unistd.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <errno.h>
#include <stdio.h>
#include <fcntl.h>
#include <sys/ioctl.h>
static pid_t child;
static void stop(int sig) { if(child>0) { kill(-child,SIGTERM); kill(-child,SIGKILL); } _exit(128+sig); }
static int all(int fd,char *p,ssize_t n) { while(n>0) { ssize_t k=write(fd,p,n); if(k<0&&errno==EINTR)continue; if(k<=0)return -1;p+=k;n-=k; }return 0; }
int main(int argc,char **argv) {
 if(argc<3)return 2;
 int cols=getenv("AGENT_REMOTE_COLS")?atoi(getenv("AGENT_REMOTE_COLS")):80;
 int rows=getenv("AGENT_REMOTE_ROWS")?atoi(getenv("AGENT_REMOTE_ROWS")):28;
 if(cols<2||cols>1000||rows<2||rows>500)return 2;
 int control=fcntl(3,F_GETFD)>=0?3:-1;
 struct winsize size={.ws_row=rows,.ws_col=cols};int master;
 child=forkpty(&master,NULL,NULL,&size);
 if(child<0)return 1;
 if(child==0) { if(control>=0)close(control);if(chdir(argv[1]))_exit(126);setenv("TERM","xterm-256color",1);unsetenv("COLUMNS");unsetenv("LINES");execvp(argv[2],argv+2);_exit(127); }
 signal(SIGTERM,stop);signal(SIGHUP,stop);signal(SIGINT,stop);signal(SIGPIPE,SIG_IGN);
 char buf[16384],dimensions[64];int used=0;
 for(;;) {
  fd_set set;FD_ZERO(&set);FD_SET(0,&set);FD_SET(master,&set);
  if(control>=0)FD_SET(control,&set);
  if(select(master+1,&set,NULL,NULL,NULL)<0){if(errno==EINTR)continue;break;}
  if(control>=0&&FD_ISSET(control,&set)){
   char updates[256];ssize_t n=read(control,updates,sizeof updates);
   if(n<=0){close(control);control=-1;}
   for(ssize_t i=0;i<n;i++){
    if(updates[i]=='\n'){
     dimensions[used]=0;int c,r;
     if(sscanf(dimensions,"%d %d",&c,&r)==2&&c>=2&&c<=1000&&r>=2&&r<=500){size.ws_col=c;size.ws_row=r;ioctl(master,TIOCSWINSZ,&size);}
     used=0;
    }else if(used<(int)sizeof(dimensions)-1)dimensions[used++]=updates[i];
   }
  }
  if(FD_ISSET(master,&set)){ssize_t n=read(master,buf,sizeof buf);if(n<=0)break;if(all(1,buf,n))break;}
  if(FD_ISSET(0,&set)){ssize_t n=read(0,buf,sizeof buf);if(n<=0){stop(SIGHUP);}if(all(master,buf,n))break;}
 }
 close(master);int status;while(waitpid(child,&status,0)<0&&errno==EINTR){};
 return WIFEXITED(status)?WEXITSTATUS(status):130;
}
