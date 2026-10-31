#!/usr/bin/env python3
"""Build a standalone local Mac browser for the running Agent Remote knowledge API."""
import os
import plistlib
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
app = root / 'build' / 'Agent Remote Knowledge.app'
contents = app / 'Contents'
(contents / 'MacOS').mkdir(parents=True, exist_ok=True)
(contents / 'Resources').mkdir(exist_ok=True)
with (contents / 'Info.plist').open('wb') as file:
    plistlib.dump(dict(CFBundleExecutable='KnowledgeBrowser', CFBundleIdentifier='com.agentremote.knowledge',
        CFBundleName='Agent Remote Knowledge', CFBundleDisplayName='Agent Remote Knowledge',
        CFBundlePackageType='APPL', CFBundleShortVersionString='2.0', CFBundleVersion='2',
        LSMinimumSystemVersion='13.5', NSHighResolutionCapable=True, CFBundleIconFile='AppIcon'), file)
icon = root / 'assets/branding/AgentRemote.icns'
if icon.exists():
    shutil.copy2(icon, contents / 'Resources/AppIcon.icns')
env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Library/Developer/CommandLineTools'))
subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macos13.5',
    *[str(p) for p in sorted((root / 'macos/KnowledgeBrowser').glob('*.swift'))], str(root / 'macos/AgentRemote/MessageMarkdown.swift'), '-o', str(contents / 'MacOS/KnowledgeBrowser')], env=env, check=True)
subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
print(app)
