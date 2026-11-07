#!/usr/bin/env bash
# Connect the real Jev (TypeSafe) on the droplet: the same news-score model the claude.ai boards use. Run as root:
#   bash /opt/conviction/tools/jev_setup.sh
# 1. installs TypeSafe's "evaluate" program (pinned version, checksum verified) into /usr/local/bin
# 2. asks for your TypeSafe API key in a hidden prompt (press Enter to keep a key already saved) and stores it only in .env
# 3. restarts the boards and asks Jev one test question
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root."; exit 1; }
DIR=/opt/conviction; cd "$DIR"
VER=v0.4.14
REPO=itsmostafa/system-one-connector
getv(){ grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
setv(){ grep -vE "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "1/3 Installing TypeSafe's Jev program ($VER)"
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Unsupported machine: $(uname -m)"; exit 1 ;; esac
TMP=$(mktemp -d); trap 'rm -rf -- "$TMP"' EXIT
F="evaluate-linux-$ARCH.tar.gz"
curl -fsSL -o "$TMP/$F" "https://github.com/$REPO/releases/download/$VER/$F"
curl -fsSL -o "$TMP/SHA256SUMS.txt" "https://github.com/$REPO/releases/download/$VER/SHA256SUMS.txt"
( cd "$TMP" && grep " $F\$\| \*$F\$" SHA256SUMS.txt | sha256sum -c - ) || { echo "Checksum did not match; nothing installed."; exit 1; }
mkdir -p "$TMP/x" && tar -xzf "$TMP/$F" -C "$TMP/x"
BIN=$(find "$TMP/x" -type f -name evaluate | head -1)
[ -n "$BIN" ] || { echo "The download did not contain the evaluate program."; exit 1; }
install -m 0755 "$BIN" /usr/local/bin/evaluate
/usr/local/bin/evaluate version
setv EVALUATE_CMD /usr/local/bin/evaluate

say "2/3 TypeSafe API key"
if [ -n "$(getv TYPESAFE_API_KEY)" ]; then echo "   (a key is already saved: press Enter to keep it)"; fi
read -r -s -p "   Paste your TypeSafe API key (hidden), then Enter: " K </dev/tty; echo
K="$(printf '%s' "$K" | tr -d '[:space:]')"
if [ -n "$K" ]; then setv TYPESAFE_API_KEY "$K"; echo "   saved"; else echo "   kept"; fi
unset K
[ -n "$(getv TYPESAFE_API_KEY)" ] || { echo "No TypeSafe key saved: Jev stays off."; exit 1; }

say "3/3 Restarting the boards and asking Jev a test question"
systemctl restart conviction
PORT="$(getv PORT)"; PORT="${PORT:-80}"
for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 1; done
curl -s -X POST -H 'content-type: application/json' "http://127.0.0.1:$PORT/api/mcp" \
  -d '{"server":"host:evaluate","tool":"evaluate","input":{"questions":{"up":{"type":"noul","instructions":"Given these news headlines, is this stock more likely to rise than fall today?"}},"state":{"ticker":"TEST","headlines":["Company beats earnings estimates and raises full-year guidance"]}}}' \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
try:
    p=d["result"]["payload"]["answers"]["up"]["noul"]; print("   Jev answered: %.2f chance of rising for a good-news headline. Jev is on (TypeSafe)." % p)
except Exception:
    print("   Jev did not answer:", (d.get("error") or {}).get("message", d))'
