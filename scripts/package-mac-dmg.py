#!/usr/bin/env python3
"""Package the already built/verified Mac app without changing its contents."""
from pathlib import Path
import argparse
import shutil
import subprocess

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app',type=Path,default=root/'build/mac/Agent Remote.app')
parser.add_argument('--output',type=Path,default=root/'build/AgentRemote.dmg')
args=parser.parse_args()
app=args.app.resolve()
dmg=args.output.resolve()
dmg.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
staging=dmg.parent/'dmg'
if staging == app or staging in app.parents:
    parser.error('Staging directory must not contain the source app.')
if staging.exists():shutil.rmtree(staging)
staging.mkdir()
shutil.copytree(app,staging/app.name,symlinks=True)
(staging/'Applications').symlink_to('/Applications')
shutil.copy2(root/'macos/INSTALL.txt',staging/'READ ME FIRST.txt')
if dmg.exists():dmg.unlink()
subprocess.run(['hdiutil','create','-volname','Agent Remote','-srcfolder',str(staging),'-ov','-format','UDZO',str(dmg)],check=True)
print(f'Created {dmg} ({dmg.stat().st_size/1024/1024:.1f} MB)',flush=True)
