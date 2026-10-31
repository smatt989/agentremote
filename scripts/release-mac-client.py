#!/usr/bin/env python3
"""Archive, Developer ID-sign and notarize the Mac client (the iPhone app built for Mac Catalyst).

Produces build/release-mac-client/Agent Remote Client.zip, which installs on any Apple Silicon or
Intel Mac running macOS 14+. The client pairs with a host Mac exactly like the phone does."""
import json, os, plistlib, shutil, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
TEAM = 'YA9PU25M2S'
KEY = Path.home() / '.appstoreconnect/private_keys'/f"AuthKey_{os.environ.get('ASC_KEY_ID','')}.p8"
AUTH = ['-authenticationKeyPath', KEY, '-authenticationKeyID', os.environ.get('ASC_KEY_ID',''), '-authenticationKeyIssuerID', os.environ.get('ASC_ISSUER_ID','')]
NOTARY = ['--keychain-profile', 'AgentRemote', '--keychain', Path.home() / 'Library/Keychains/login.keychain-db']
env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
def run(*command, **kwargs):
    return subprocess.run([str(x) for x in command], check=True, **{'env': env, **kwargs})
out = ROOT / 'build/release-mac-client'
if out.exists(): shutil.rmtree(out)
out.mkdir(parents=True)
archive = out / 'AgentRemoteClient.xcarchive'
run('xcodebuild', '-project', ROOT / 'ios/AgentRemote.xcodeproj', '-scheme', 'AgentRemote', '-configuration', 'Release',
    '-destination', 'generic/platform=macOS,variant=Mac Catalyst', '-archivePath', archive,
    '-allowProvisioningUpdates', *AUTH, f'DEVELOPMENT_TEAM={TEAM}', 'archive', '-quiet')
# Cloud-managed Developer ID signing needs the Account Holder, so sign with the certificate in this keychain
# and a matching Developer ID profile (the keychain entitlement requires one).
pem = run('security', 'find-certificate', '-c', f'Developer ID Application: Matthew Slotkin ({TEAM})', '-p', capture_output=True, text=True).stdout
serial = run('openssl', 'x509', '-noout', '-serial', input=pem, capture_output=True, text=True).stdout.strip().split('=')[1]
try:
    profile = run('node', ROOT / 'scripts/mac-client-profile.mjs', serial, capture_output=True, text=True,
        env=dict(env, ASC_KEY_ID=os.environ.get('ASC_KEY_ID',''), ASC_ISSUER_ID=os.environ.get('ASC_ISSUER_ID',''))).stdout.strip()
except subprocess.CalledProcessError as error:
    # The API refuses everything while an updated Apple agreement is pending; the profile installed by the last
    # successful run is still valid, so use it.
    profile = None
    for path in (Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles').glob('*.provisionprofile'):
        info = plistlib.loads(run('security', 'cms', '-D', '-i', path, capture_output=True).stdout)
        if info.get('Name') == 'Agent Remote Client Developer ID': profile = info['UUID']
    if not profile: raise SystemExit(f'Developer ID profile unavailable: {error.stderr.strip()[-400:]}')
    print(f'App Store Connect API unavailable; using the installed profile {profile}')
options = out / 'ExportOptions.plist'
options.write_bytes(plistlib.dumps({'method': 'developer-id', 'teamID': TEAM, 'signingStyle': 'manual', 'destination': 'export',
    'signingCertificate': 'Developer ID Application', 'provisioningProfiles': {'com.agentremote.iphone': profile}}))
run('xcodebuild', '-exportArchive', '-archivePath', archive, '-exportPath', out / 'export', '-exportOptionsPlist', options, *AUTH, '-quiet')
app = out / 'Agent Remote Client.app'
shutil.move(out / 'export/AgentRemote.app', app)
run('codesign', '--verify', '--deep', '--strict', app)
upload = out / 'upload.zip'
run('ditto', '-c', '-k', '--keepParent', app, upload)
# notarytool exits 0 even when Apple rejects the upload, so read the status
result = json.loads(run('xcrun', 'notarytool', 'submit', upload, *NOTARY, '--wait', '--output-format', 'json', capture_output=True, text=True).stdout)
if result.get('status') != 'Accepted':
    raise SystemExit(f'Notarization failed: {result}. Inspect with: xcrun notarytool log {result.get("id")} --keychain-profile AgentRemote')
run('xcrun', 'stapler', 'staple', app)
run('spctl', '--assess', '--type', 'execute', '--verbose', app)
final = out / 'Agent Remote Client.zip'
run('ditto', '-c', '-k', '--keepParent', app, final)
upload.unlink()
print(f'Notarized: {final}')
