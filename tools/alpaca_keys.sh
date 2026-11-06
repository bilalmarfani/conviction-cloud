#!/usr/bin/env bash
# Save the Alpaca PAPER keys for the three strategy accounts on this droplet, then restart the boards and show
# whether each account connected. Run as root:   bash /opt/conviction/tools/alpaca_keys.sh
# Keys are typed into hidden prompts and stored only in /opt/conviction/.env (readable by root only).
# Press Enter without typing to keep an account's current keys. Live keys (starting AK) are refused.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root."; exit 1; }
DIR=/opt/conviction; cd "$DIR"
getv(){ grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
setv(){ grep -vE "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
asks(){ local v; read -r -s -p "$1" v </dev/tty; echo >&2; printf '%s' "$v" | tr -d '[:space:]'; }

for row in "FIVE|v2 5-MIN" "TECHGO|v2 TECH GO" "M1|v3 1-min Momentum"; do
  K="${row%%|*}"; NAME="${row#*|}"
  say "$NAME paper account"
  if [ -n "$(getv ALPACA_${K}_KEY)" ]; then echo "   (keys already saved: press Enter twice to keep them)"; fi
  key=$(asks "   API key ID (starts with PK): ")
  if [ -z "$key" ]; then echo "   kept"; continue; fi
  case "$key" in PK*) ;; AK*) echo "   That is a LIVE key (AK...). Only paper keys are allowed here. Skipped."; continue ;; *) echo "   That does not look like an Alpaca paper key. Skipped."; continue ;; esac
  sec=$(asks "   Secret key: ")
  [ -n "$sec" ] || { echo "   No secret entered. Skipped."; continue; }
  setv "ALPACA_${K}_KEY" "$key"; setv "ALPACA_${K}_SECRET" "$sec"; echo "   saved"
  unset key sec
done

say "Restarting the boards"
systemctl restart conviction
PORT="$(getv PORT)"; PORT="${PORT:-80}"
for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 1; done
sleep 4
say "Alpaca paper accounts"
curl -s "http://127.0.0.1:$PORT/api/health" | python3 -c '
import json,sys
b=(json.load(sys.stdin) or {}).get("broker") or {}
for a in (b.get("accounts") or {}).values():
    i=a.get("info") or {}
    print("   %-20s %s" % (a["name"], ("connected  (account ...%s, equity $%s, options level %s)" % (i.get("number"), i.get("equity"), i.get("optionsLevel"))) if a.get("connected") else ("NOT connected: " + str(a.get("why")))))
print("   Paper trading only. To stop new entries at any time:  touch /opt/conviction/data/HALT_TRADING   (remove the file to resume)")'
