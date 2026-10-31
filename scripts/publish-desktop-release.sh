#!/bin/zsh
# Publishes a built desktop release: writes update.json (read by the apps' automatic updaters), creates the GitHub
# release on smatt989/agentremote-site, re-downloads and checks the assets, then points the website at it.
# Usage: scripts/publish-desktop-release.sh <version> <release dir containing AgentRemote.dmg, AgentRemoteClient.zip, notes.md>
set -e
VERSION=$1; DIR=${2:A}
[ -n "$VERSION" ] && [ -f "$DIR/AgentRemote.dmg" ] && [ -f "$DIR/AgentRemoteClient.zip" ] && [ -f "$DIR/notes.md" ] || { echo "usage: $0 <version> <release dir with dmg, zip, notes.md>"; exit 2; }
cd "${0:A:h}/.."
REPO=smatt989/agentremote-site
BASE="https://github.com/$REPO/releases/download/v$VERSION"
build_of() { # CFBundleVersion inside the DMG or zip
  local tmp=$(mktemp -d)
  if [[ $1 == *.dmg ]]; then hdiutil attach -nobrowse -readonly -mountpoint "$tmp/m" "$1" >/dev/null; defaults read "$tmp/m/Agent Remote.app/Contents/Info" CFBundleVersion; hdiutil detach "$tmp/m" >/dev/null
  else ditto -x -k "$1" "$tmp"; defaults read "$tmp/Agent Remote Client.app/Contents/Info" CFBundleVersion; fi
  rm -rf "$tmp"
}
MAC_BUILD=$(build_of "$DIR/AgentRemote.dmg"); CLIENT_BUILD=$(build_of "$DIR/AgentRemoteClient.zip")
(cd "$DIR" && shasum -a 256 AgentRemote.dmg AgentRemoteClient.zip > SHA256SUMS)
/usr/bin/python3 - "$DIR" "$VERSION" "$BASE" "$MAC_BUILD" "$CLIENT_BUILD" <<'EOF'
import hashlib, json, sys
d, version, base, mac, client = sys.argv[1:]
sha = lambda name: hashlib.sha256(open(f'{d}/{name}', 'rb').read()).hexdigest()
json.dump({'version': version,
           'mac': {'build': int(mac), 'url': f'{base}/AgentRemote.dmg', 'sha256': sha('AgentRemote.dmg')},
           'client': {'build': int(client), 'url': f'{base}/AgentRemoteClient.zip', 'sha256': sha('AgentRemoteClient.zip')}},
          open(f'{d}/update.json', 'w'), indent=2)
EOF
echo "update.json: mac build $MAC_BUILD, client build $CLIENT_BUILD"
gh release create "v$VERSION" -R $REPO --target main --title "Agent Remote $VERSION" --notes-file "$DIR/notes.md" \
  "$DIR/AgentRemote.dmg" "$DIR/AgentRemoteClient.zip" "$DIR/SHA256SUMS" "$DIR/update.json"
# What the updaters will actually fetch: the latest-release redirect, then each asset against its checksum.
CHECK=$(mktemp -d)
curl -sfL "https://github.com/$REPO/releases/latest/download/update.json" -o "$CHECK/update.json"
cmp -s "$CHECK/update.json" "$DIR/update.json" || { echo "latest/download/update.json does not match"; exit 1; }
for f in AgentRemote.dmg AgentRemoteClient.zip; do curl -sfL "$BASE/$f" -o "$CHECK/$f"; done
(cd "$CHECK" && shasum -a 256 -c "$DIR/SHA256SUMS")
rm -rf "$CHECK"
# Website download link.
/usr/bin/python3 - "$BASE" <<'EOF'
import json, sys
p = 'website/config.json'; c = json.load(open(p)); c['macUrl'] = sys.argv[1] + '/AgentRemote.dmg'
open(p, 'w').write(json.dumps(c, indent=2) + '\n')
EOF
rm -rf build/website && node website/build.mjs >/dev/null
git -C build/agentremote-site pull -q --ff-only
rsync -a --delete --exclude .git --exclude .nojekyll build/website/ build/agentremote-site/
git -C build/agentremote-site add -A
git -C build/agentremote-site commit -q -m "Link Mac $VERSION ($MAC_BUILD) and Agent Remote Client build $CLIENT_BUILD (release v$VERSION)"
git -C build/agentremote-site push -q
echo "published v$VERSION; site $(git -C build/agentremote-site rev-parse --short HEAD)"
