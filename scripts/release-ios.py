#!/usr/bin/env python3
"""Archive a signed iPhone release and export an IPA or upload to TestFlight."""
import argparse
import os
from pathlib import Path
import plistlib
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--team', required=True, help='Apple Developer team ID')
parser.add_argument('--bundle-id', required=True, help='Registered App Store Connect bundle identifier')
parser.add_argument('--build-number', required=True, type=int, help='Unused positive build number')
parser.add_argument('--push', action='store_true', help='Enable Apple Push capability for this paid-team release')
parser.add_argument('--upload', action='store_true', help='Upload to App Store Connect instead of exporting locally')
args = parser.parse_args()
if args.build_number < 1:
    parser.error('Build number must be positive.')
env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
def run(*command, **kwargs):
    return subprocess.run([str(x) for x in command], check=True, env=env, **kwargs)
version = run('xcodebuild', '-version', capture_output=True, text=True).stdout
match = re.search(r'Xcode (\d+)', version)
if not match or int(match[1]) < 26:
    parser.error('App Store uploads require Xcode 26+ and the iOS 26+ SDK. Select it with DEVELOPER_DIR.')
sdk = run('xcrun', '--sdk', 'iphoneos', '--show-sdk-version', capture_output=True, text=True).stdout.strip()
if int(sdk.split('.')[0]) < 26:
    parser.error('Install the iOS 26 or newer SDK in Xcode.')
output = ROOT / 'build/release-ios' / str(args.build_number)
output.mkdir(parents=True, exist_ok=True)
archive = output / 'AgentRemote.xcarchive'
# The app embeds a Notification Service Extension, so the bundle ID and app entitlements are passed through
# project variables (AGENT_REMOTE_*) rather than PRODUCT_BUNDLE_IDENTIFIER/CODE_SIGN_ENTITLEMENTS, which would also apply to it.
run('xcodebuild', '-project', ROOT / 'ios/AgentRemote.xcodeproj', '-scheme', 'AgentRemote', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', archive, '-allowProvisioningUpdates', f'DEVELOPMENT_TEAM={args.team}', f'AGENT_REMOTE_BUNDLE_ID={args.bundle_id}', f'CURRENT_PROJECT_VERSION={args.build_number}', *(['AGENT_REMOTE_APP_ENTITLEMENTS=AgentRemote/Push.entitlements','APNS_ENVIRONMENT=production'] if args.push else []), 'archive')
options = output / 'ExportOptions.plist'
options.write_bytes(plistlib.dumps({'method': 'app-store-connect', 'teamID': args.team, 'signingStyle': 'automatic', 'destination': 'upload' if args.upload else 'export', 'manageAppVersionAndBuildNumber': False, 'uploadSymbols': True}))
run('xcodebuild', '-exportArchive', '-archivePath', archive, '-exportPath', output / 'export', '-exportOptionsPlist', options, '-allowProvisioningUpdates')
print('Uploaded; check processing and export compliance in App Store Connect.' if args.upload else f'Exported release: {output / "export"}')
