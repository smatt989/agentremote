#!/usr/bin/env python3
"""Stage, Developer-ID sign, and optionally notarize an existing Mac build."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, default=ROOT / 'build/mac/Agent Remote.app')
parser.add_argument('--identity', required=True, help='Developer ID Application certificate name')
parser.add_argument('--notary-profile', help='Existing notarytool Keychain profile; submits to Apple when supplied')
parser.add_argument('--notary-keychain', type=Path, help='Keychain file holding the notarytool profile (e.g. ~/Library/Keychains/login.keychain-db)')
args = parser.parse_args()
if not args.identity.startswith('Developer ID Application:'):
    parser.error('Use a Developer ID Application identity, not ad-hoc or development signing.')
env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
def run(*command, **kwargs):
    return subprocess.run([str(x) for x in command], check=True, env=env, **kwargs)
identities = run('security', 'find-identity', '-v', '-p', 'codesigning', capture_output=True, text=True).stdout
if f'"{args.identity}"' not in identities:
    parser.error('The requested signing identity and private key are not available in this Mac’s Keychain.')
source = args.app.resolve()
if not source.is_dir():
    parser.error('Build the Mac app first using scripts/build-mac-app.py.')
output = ROOT / 'build/release-mac'
output.mkdir(parents=True, exist_ok=True)
app = output / 'Agent Remote.app'
if source == app.resolve():
    parser.error('Source must differ from the staged release app.')
if app.exists():
    shutil.rmtree(app)
shutil.copytree(source, app, symlinks=True)
# Start with Node's own runtime entitlements, retaining its executable-memory
# requirements but removing debugger access, which notarization forbids.
for node in sorted((app / 'Contents/Resources/runtime').glob('*/bin/node')):
    result = run('codesign', '-d', '--entitlements', ':-', node, capture_output=True)
    entitlements = plistlib.loads(result.stdout) if result.stdout.strip() else {}
    entitlements.pop('com.apple.security.get-task-allow', None)
    entitlements['com.apple.security.cs.allow-jit'] = True
    entitlements['com.apple.security.cs.allow-unsigned-executable-memory'] = True
    path = output / (node.parent.parent.name + '-entitlements.plist')
    path.write_bytes(plistlib.dumps(entitlements))
    run('codesign', '--force', '--sign', args.identity, '--timestamp', '--options', 'runtime', '--entitlements', path, node)
run('codesign', '--force', '--sign', args.identity, '--timestamp', '--options', 'runtime', app / 'Contents/Resources/service/TerminalHost')
# Apple Events automation is used by browser tools launched from the app.
app_entitlements = output / 'app-entitlements.plist'
app_entitlements.write_bytes(plistlib.dumps({'com.apple.security.automation.apple-events': True}))
run('codesign', '--force', '--sign', args.identity, '--timestamp', '--options', 'runtime', '--entitlements', app_entitlements, app)
run('codesign', '--verify', '--deep', '--strict', app)
if not args.notary_profile:
    print(f'Signed app: {app}\nNot yet notarized. Rerun with --notary-profile after configuring notarytool credentials.')
    raise SystemExit(0)
notary = ['--keychain-profile', args.notary_profile] + (['--keychain', args.notary_keychain.expanduser()] if args.notary_keychain else [])
archive = output / 'AgentRemote.zip'
if archive.exists():
    archive.unlink()
run('ditto', '-c', '-k', '--keepParent', app, archive)
result = run('xcrun', 'notarytool', 'submit', archive, *notary, '--wait', '--output-format', 'json', capture_output=True, text=True)
(output / 'notarization.json').write_text(result.stdout)
report = json.loads(result.stdout)
if report.get('status') != 'Accepted':
    raise SystemExit(f'Notarization status: {report.get("status")}; see {output / "notarization.json"}')
run('xcrun', 'stapler', 'staple', app)
run('xcrun', 'stapler', 'validate', app)
run('spctl', '--assess', '--type', 'execute', '--verbose=2', app)
staging = output / 'dmg'
if staging.exists():
    shutil.rmtree(staging)
staging.mkdir()
shutil.copytree(app, staging / app.name, symlinks=True)
(staging / 'Applications').symlink_to('/Applications')
shutil.copyfile(ROOT / 'macos/INSTALL.txt', staging / 'INSTALL.txt')
dmg = output / 'AgentRemote.dmg'
run('hdiutil', 'create', '-volname', 'Agent Remote', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg)
run('codesign', '--sign', args.identity, '--timestamp', dmg)
# Staple a ticket to the DMG as well as its enclosed app.
result = run('xcrun', 'notarytool', 'submit', dmg, *notary, '--wait', '--output-format', 'json', capture_output=True, text=True)
(output / 'dmg-notarization.json').write_text(result.stdout)
if json.loads(result.stdout).get('status') != 'Accepted':
    raise SystemExit('DMG notarization did not pass; see dmg-notarization.json.')
run('xcrun', 'stapler', 'staple', dmg)
run('xcrun', 'stapler', 'validate', dmg)
print(f'Notarized release: {dmg}')
