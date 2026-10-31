#!/bin/zsh
# Installs a downloaded, already-verified Agent Remote update over the running app and relaunches it.
# Started detached by the app's updater (its own session, so stopping the app does not stop this script).
# Generalised from the hand-run update-mac-0.8.x scripts: same stop / back up / swap / health-check / roll-back sequence.
# Usage: install-update.sh <new app bundle> <installed app bundle> [force]   (force: the user chose to install now)
# Exit codes: 0 updated, 1 failed (rolled back or nothing changed), 3 busy (sessions active; nothing changed).
NEW="$1"; DEST="$2"; FORCE="$3"
STATE="$HOME/Library/Application Support/AgentRemote"
UPDATES="$STATE/updates"; mkdir -p "$UPDATES"
LOG="$UPDATES/install.log"
exec >> "$LOG" 2>&1
DB="$STATE/state.sqlite"
STAMP=$(date +%Y%m%d-%H%M%S)
OLD="$UPDATES/previous-$STAMP.app"
DBAT="$UPDATES/state-before-update-$STAMP.sqlite"
PY=/usr/bin/python3
log() { echo "[$(date '+%F %T')] $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Agent Remote\"" >/dev/null 2>&1; }
version() { echo "$(defaults read "$1/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null) ($(defaults read "$1/Contents/Info.plist" CFBundleVersion 2>/dev/null))"; }
pids() { ps -axo pid=,command= | awk -v p="$1" -v q="$2" '{pid=$1; sub(/^ *[0-9]+ /,""); if (index($0,p)==1 && index($0,q)>0) print pid}'; }
service_pid() { pids "$DEST/Contents/Resources/runtime/" "/Contents/Resources/service/desktop/src/server.mjs" | head -1; }
app_pid() { pids "$DEST/Contents/MacOS/AgentRemote" "" | head -1; }
healthy() { [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health)" != "000" ] && [ -n "$(service_pid)" ]; }
active() { $PY -c 'import json,sys;print(json.load(open(sys.argv[1])).get("activeSessions",0))' "$STATE/desktop-status.json" 2>/dev/null || echo 0; }
devices() { sqlite3 -readonly "$DB" "SELECT 'device',id,name FROM devices ORDER BY id; SELECT 'relay',id FROM relay_devices ORDER BY id;" 2>&1; }
stop_app() {
  local WPID=$(app_pid) SPID=$(service_pid)
  log "stopping app=[$WPID] service=[$SPID]"
  [ -n "$WPID" ] && kill -TERM $WPID
  sleep 3
  [ -n "$SPID" ] && kill -0 $SPID 2>/dev/null && kill -TERM $SPID
  for i in {1..40}; do alive=0; for p in $WPID $SPID; do kill -0 $p 2>/dev/null && alive=1; done; [ $alive = 0 ] && break; sleep 1; done
  for p in $WPID $SPID; do kill -0 $p 2>/dev/null && { log "SIGKILL $p"; kill -KILL $p; }; done
  sleep 2
  for i in {1..30}; do lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
}
rollback() {
  log "ROLLBACK: $1"
  stop_app
  local check=$(sqlite3 "$DB" "PRAGMA quick_check;" 2>&1 | head -1)
  if [ "$check" != "ok" ]; then
    log "database check: $check; restoring the copy taken before the update"
    mkdir -p "$UPDATES/failed-db-$STAMP"; mv "$DB" "$DB-wal" "$DB-shm" "$UPDATES/failed-db-$STAMP/" 2>/dev/null
    cp "$DBAT" "$DB" && chmod 600 "$DB"
  fi
  if [ -d "$OLD" ]; then rm -rf "$DEST" && mv "$OLD" "$DEST" && log "previous bundle restored"; fi
  open "$DEST"
  ok=0; for i in {1..120}; do healthy && { ok=1; break; }; sleep 1; done
  [ $ok = 1 ] && notify "An Agent Remote update failed a check; the previous version is running again." || notify "Agent Remote did not restart. Open it from Applications."
  log "UPDATE FAILED, rolled back (previous version healthy: $ok)"
  exit 1
}

log "update requested: $(version "$NEW") over $(version "$DEST")"
codesign --verify --deep --strict "$NEW" || { log "new bundle fails codesign; nothing changed"; exit 1; }
[ "$(codesign -d -r- "$NEW" 2>&1 | tail -1)" = "$(codesign -d -r- "$DEST" 2>&1 | tail -1)" ] || { log "designated requirement differs; nothing changed"; exit 1; }
# The app only starts this when idle, but a session may have begun since; never interrupt one.
[ "$(active)" = "0" ] || [ "$FORCE" = force ] || { log "sessions active ($(active)); postponed, nothing changed"; exit 3; }
devices > "$UPDATES/devices-before-$STAMP.txt"

stop_app
sqlite3 "$DB" ".backup '$DBAT'" || { log "database backup failed; relaunching unchanged"; open "$DEST"; exit 1; }
mv "$DEST" "$OLD" || { log "could not move the installed bundle; relaunching unchanged"; open "$DEST"; exit 1; }
ditto "$NEW" "$DEST" || rollback "ditto failed"
codesign --verify --deep --strict "$DEST" || rollback "installed bundle fails codesign"
log "installed $(version "$DEST"); $(spctl -a -vv "$DEST" 2>&1 | tail -1)"

open "$DEST"
ok=0; for i in {1..120}; do healthy && { ok=1; break; }; sleep 1; done
[ $ok = 1 ] || rollback "service not healthy within 120 s"
TOKEN=$(cat "$STATE/desktop-token")
curl -sf -m 30 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/agents >/dev/null || rollback "GET /agents failed"
paired=$(grep -c '^device' "$UPDATES/devices-before-$STAMP.txt")
if [ "$paired" -gt 0 ]; then
  relay=no; for i in {1..90}; do
    r=$($PY -c 'import json,sys;d=json.load(open(sys.argv[1]));print("yes" if d.get("relay")=="connected" and str(d.get("pid"))==sys.argv[2] else "no")' "$STATE/desktop-status.json" "$(service_pid)" 2>/dev/null)
    [ "$r" = "yes" ] && { relay=yes; break; }; sleep 1
  done
  [ $relay = yes ] || rollback "relay not connected within 90 s"
fi
devices | cmp -s "$UPDATES/devices-before-$STAMP.txt" - || rollback "paired device records changed"
[ "$(sqlite3 -readonly "$DB" "PRAGMA quick_check;" 2>&1 | head -1)" = "ok" ] || rollback "database quick_check failed"
"$DEST/Contents/Resources/runtime/$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)/bin/node" "$DEST/Contents/Resources/service/desktop/src/terminal-setup.mjs" >/dev/null 2>&1
# Keep only the newest rollback copy and database snapshot.
ls -dt "$UPDATES"/previous-*.app 2>/dev/null | tail -n +2 | while read -r p; do rm -rf "$p"; done
ls -t "$UPDATES"/state-before-update-*.sqlite "$UPDATES"/devices-before-*.txt 2>/dev/null | tail -n +3 | while read -r p; do rm -f "$p"; done
notify "Agent Remote updated to $(defaults read "$DEST/Contents/Info.plist" CFBundleShortVersionString)."
log "UPDATE OK: $(version "$DEST")"
