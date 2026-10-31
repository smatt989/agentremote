import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdirSync,existsSync,readFileSync,writeFileSync,copyFileSync,chmodSync} from 'node:fs';
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function integrationScript({node,launcher}) {
  return '# Agent Remote shared terminal access.\n'+['codex','claude'].map(provider=>`function ${provider}() {\n  if [[ -t 0 && -t 1 && -x ${quote(node)} && -f ${quote(launcher)} ]]; then\n    command /usr/bin/env NODE_NO_WARNINGS=1 ${quote(node)} ${quote(launcher)} ${provider} "$(builtin whence -p ${provider})" "$@"\n  else\n    command ${provider} "$@"\n  fi\n}\n`).join('')+
    `function pickup() {\n  if [[ -t 0 && -t 1 && -x ${quote(node)} && -f ${quote(launcher)} ]]; then\n    command /usr/bin/env NODE_NO_WARNINGS=1 ${quote(node)} ${quote(launcher)} pickup "$(builtin whence -p claude)" "$(builtin whence -p codex)" "$@"\n  else\n    print -u2 'Agent Remote: pickup needs an interactive terminal and Agent Remote installed.'; return 1\n  fi\n}\n`;
}
export function installTerminal({homeDirectory=homedir(),node=process.execPath,launcher=fileURLToPath(new URL('./terminal.mjs',import.meta.url))}={}) {
  const directory=join(homeDirectory,'Library','Application Support','AgentRemote');mkdirSync(directory,{recursive:true,mode:0o700});
  const integration=join(directory,'terminal.zsh');
  writeFileSync(integration,integrationScript({node,launcher}),{mode:0o600});chmodSync(integration,0o600);
  const zshrc=join(homeDirectory,'.zshrc');const marker='# Agent Remote terminal access';
  const old=existsSync(zshrc)?readFileSync(zshrc,'utf8'):'';
  if(!old.includes(marker)){
    if(existsSync(zshrc)){const backups=join(directory,'backups');mkdirSync(backups,{recursive:true,mode:0o700});const backup=join(backups,'zshrc-before-terminal-'+Date.now());copyFileSync(zshrc,backup);chmodSync(backup,0o600);}
    writeFileSync(zshrc,old+'\n'+marker+'\n[[ ! -f '+quote(integration)+' ]] || source '+quote(integration)+'\n',{mode:0o600});
  }
  return {integration,message:'Codex and Claude terminal access enabled. Open a new Terminal tab and run codex or claude normally, or pickup to continue a phone conversation. Existing sessions are unchanged. Use command codex or command claude to bypass phone access.'};
}
// Keeps an already-enabled integration in step with the running app (new shell commands); never enables it.
export function refreshTerminal({homeDirectory=homedir(),node=process.execPath,launcher=fileURLToPath(new URL('./terminal.mjs',import.meta.url))}={}) {
  const integration=join(homeDirectory,'Library','Application Support','AgentRemote','terminal.zsh');
  if(!existsSync(integration))return false;
  const script=integrationScript({node,launcher});if(readFileSync(integration,'utf8')===script)return false;
  writeFileSync(integration,script,{mode:0o600});chmodSync(integration,0o600);return true;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(installTerminal().message);}catch(error){console.error(error.message);process.exitCode=1;}}
