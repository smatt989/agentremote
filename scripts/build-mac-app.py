#!/usr/bin/env python3
"""Build the self-contained macOS app and DMG. No Apple account or notarization.

Downloads official Node distributions, verifies published SHA-256 checksums,
and packages only allowlisted service sources plus production npm dependencies.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app-only', action='store_true')
parser.add_argument('--output-dir', type=Path, default=ROOT / 'build/mac')
options = parser.parse_args()
BUILD = options.output_dir.resolve()
CACHE = ROOT / 'build' / 'node-runtime-cache'
APP = BUILD / 'Agent Remote.app'
CONTENTS = APP / 'Contents'
RESOURCES = CONTENTS / 'Resources'
NODE_VERSION = os.environ.get('AGENT_REMOTE_NODE_VERSION', 'v24.20.0')
DEVELOPER = os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer')
ENV = dict(os.environ, DEVELOPER_DIR=DEVELOPER)

def run(args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, env=ENV, **kwargs)

def download(url, path):
    if not path.exists():
        temporary = path.with_suffix(path.suffix + '.download')
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(path)

BUILD.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
if APP.exists():
    commands = subprocess.check_output(['ps', '-axo', 'command='], text=True).splitlines()
    if any(line.startswith(str(APP / 'Contents/MacOS/AgentRemote')) or
           line.startswith(str(APP / 'Contents/Resources/runtime') + '/') for line in commands):
        raise SystemExit('This app is running. Use --output-dir to build a separate copy.')
    shutil.rmtree(APP)
(CONTENTS / 'MacOS').mkdir(parents=True)
RESOURCES.mkdir()
shutil.copy2(ROOT / 'macos/AgentRemote/Info.plist', CONTENTS / 'Info.plist')

base = f'https://nodejs.org/dist/{NODE_VERSION}'
checksums = urllib.request.urlopen(base + '/SHASUMS256.txt').read().decode()
expected = {line.split()[1]: line.split()[0] for line in checksums.splitlines()}
for arch in ['arm64', 'x64']:
    filename = f'node-{NODE_VERSION}-darwin-{arch}.tar.gz'
    archive = CACHE / filename
    print(f'Preparing official Node {NODE_VERSION} ({arch})…', flush=True)
    download(base + '/' + filename, archive)
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected[filename]:
        archive.unlink()
        raise RuntimeError(f'Checksum mismatch: {filename}')
    destination = RESOURCES / 'runtime' / arch
    (destination / 'bin').mkdir(parents=True)
    with tarfile.open(archive) as tar:
        prefix = f'node-{NODE_VERSION}-darwin-{arch}/'
        for member, target in [('bin/node', destination / 'bin/node'), ('LICENSE', destination / 'LICENSE')]:
            data = tar.extractfile(prefix + member).read()
            target.write_bytes(data)
    (destination / 'bin/node').chmod(0o755)
    # Ad-hoc integrity signatures only; no Developer ID certificate is used.
    run(['codesign', '--force', '--sign', '-', destination / 'bin/node'])

service = RESOURCES / 'service'
service.mkdir()
for relative in ['package.json', 'package-lock.json', 'desktop/relay-default.json']:
    target = service / relative; target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / relative, target)
for relative in ['desktop/src', 'shared']:
    target = service / relative; target.mkdir(parents=True, exist_ok=True)
    for path in (ROOT / relative).glob('*.mjs'): shutil.copy2(path, target / path.name)
run(['xcrun','clang','-O2','-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0',ROOT/'macos/TerminalHost/main.c','-o',service/'TerminalHost'])
run(['codesign','--force','--sign','-',service/'TerminalHost'])
run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=service)
(RESOURCES / 'Runtime-version.txt').write_text(f'Node.js {NODE_VERSION}\nOfficial downloads: {base}\n')

sources = sorted((ROOT / 'macos/AgentRemote').glob('*.swift')) + [ROOT / 'macos/KnowledgeBrowser/WikiView.swift']
sdk = subprocess.check_output(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], env=ENV, text=True).strip()
for arch in ['arm64', 'x86_64']:
    run(['xcrun', 'swiftc', '-O', '-swift-version', '5', '-parse-as-library', '-target', f'{arch}-apple-macosx13.0', '-sdk', sdk,
         *sources, '-o', BUILD / f'AgentRemote-{arch}'])
run(['lipo', '-create', BUILD / 'AgentRemote-arm64', BUILD / 'AgentRemote-x86_64', '-output', CONTENTS / 'MacOS/AgentRemote'])
run(['xcrun', 'swift', ROOT / 'scripts/make-mac-icon.swift', BUILD / 'AppIcon.iconset'])
run(['iconutil', '-c', 'icns', BUILD / 'AppIcon.iconset', '-o', RESOURCES / 'AppIcon.icns'])
for path in (ROOT / 'assets/branding').glob('MenuBarTemplate*.png'):
    shutil.copy2(path, RESOURCES / path.name)
shutil.copy2(ROOT / 'macos/INSTALL.txt', RESOURCES / 'INSTALL.txt')
shutil.copy2(ROOT / 'macos/install-update.sh', RESOURCES / 'install-update.sh')  # run by Updater.swift
run(['codesign', '--force', '--sign', '-', APP])
run(['codesign', '--verify', '--deep', '--strict', APP])

if options.app_only:
    print(f'Created {APP}', flush=True)
    sys.exit(0)

dmg = ROOT / 'build/AgentRemote.dmg' if BUILD == ROOT / 'build/mac' else BUILD / 'AgentRemote.dmg'
run([sys.executable, ROOT / 'scripts/package-mac-dmg.py', '--app', APP, '--output', dmg])
