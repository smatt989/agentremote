#!/usr/bin/env python3
"""Configure private APNs credentials for this developer's Mac, never the app bundle.

Defaults suit this developer's setup: the newest AuthKey_*.p8 in ~/Downloads, the key ID
taken from that file name, team YA9PU25M2S and the App Store bundle ID com.agentremote.iphone.
"""
import argparse,json,os,re,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument('--key',type=Path,help='Apple APNs .p8 key file (default: newest ~/Downloads/AuthKey_*.p8)')
p.add_argument('--key-id',help='APNs key ID (default: taken from the AuthKey_<ID>.p8 file name)')
p.add_argument('--team-id',default='YA9PU25M2S')
p.add_argument('--topic',action='append',help='Push-enabled bundle ID; repeat for multiple apps (default: com.agentremote.iphone)')
a=p.parse_args()
if a.key is None:
    candidates=sorted((Path.home()/'Downloads').glob('AuthKey_*.p8'),key=lambda f:f.stat().st_mtime)
    if not candidates:p.error('no AuthKey_*.p8 in ~/Downloads; pass --key')
    a.key=candidates[-1]
if not a.key.is_file():p.error('APNs key file does not exist')
if a.key_id is None:
    match=re.fullmatch(r'AuthKey_([A-Z0-9]{10})\.p8',a.key.name)
    if not match:p.error('cannot derive the key ID from the file name; pass --key-id')
    a.key_id=match.group(1)
topics=a.topic or ['com.agentremote.iphone']
subprocess.run(['openssl','pkey','-in',str(a.key),'-noout'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.umask(0o077)
root=Path.home()/'Library/Application Support/AgentRemote';root.mkdir(parents=True,exist_ok=True)
key=root/'apns-auth-key.p8'
if a.key.resolve()!=key.resolve():shutil.copyfile(a.key,key)
key.chmod(0o600)
config=root/'push-config.json';config.write_text(json.dumps({'keyPath':str(key),'keyId':a.key_id,'teamId':a.team_id,'topics':topics},indent=2)+'\n');config.chmod(0o600)
print(f'Apple Push configured privately on this Mac: key {a.key_id}, team {a.team_id}, apps {", ".join(topics)}.')
print('The running Mac service picks this up without a restart. Enable notifications in the push-enabled iPhone build, then run: node desktop/src/admin.mjs push-test')
