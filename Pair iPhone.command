#!/bin/zsh
set -e
agent_remote_root="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "$agent_remote_root"
node desktop/src/admin.mjs pair
open "${AGENT_REMOTE_STATE:-$HOME/Library/Application Support/AgentRemote}/pair-iphone.html"
