import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..',import.meta.url)));
const home = homedir();
const xml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const logs = join(home,'Library','Logs','AgentRemote'); mkdirSync(logs,{recursive:true,mode:0o700});
const dir = join(home,'Library','LaunchAgents'); mkdirSync(dir,{recursive:true});
const path = join(dir,'com.agentremote.desktop.plist');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.agentremote.desktop</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root,'desktop/src/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(join(home,'.local/bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(logs,'desktop.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs,'desktop-error.log'))}</string>
</dict></plist>`;
writeFileSync(path,plist,{mode:0o600});
console.log(`Created ${path}\nLoad it with: launchctl bootstrap gui/${process.getuid()} '${path}'`);
