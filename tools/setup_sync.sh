#!/bin/zsh
# One-time Mac setup for the v2 paper sync: saves the server address and the read-only export key
# in ~/.conviction (only you can read it), then checks that the server accepts the key.
# The key is typed into a hidden prompt: it is not shown on screen or stored anywhere else.
set -u
DIR="$HOME/.conviction"
mkdir -p "$DIR" && chmod 700 "$DIR"
print "Conviction v2 sync setup\n"
read "ADDR?Server address (the IP you open the boards with, e.g. 203.0.113.5): "
ADDR="${ADDR## }"; ADDR="${ADDR%% }"; ADDR="${ADDR%/}"
[[ "$ADDR" == http* ]] || ADDR="http://$ADDR"
print -r -- "$ADDR" > "$DIR/server"
read -s "K?Paste the EXPORT_KEY (hidden, press Enter after pasting): "; print
K="${K//[[:space:]]/}"
if [[ ${#K} -lt 20 ]]; then print "That key is too short (the server needs at least 20 characters). Nothing saved for the key."; unset K; exit 1; fi
umask 077; print -rn -- "$K" > "$DIR/export_key"; chmod 600 "$DIR/export_key"; unset K
print "Saved. Checking the server..."
python3 "$(dirname "$0")/sync_paper.py" --full | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("ok"): print("OK: the server accepted the key. It has", len(d["changed"]), "paper plays from the last 14 days. The 5-minute sync can run now.")
else: print("Problem:", d.get("error"), "- fix it, then run this setup again.")'
