#!/usr/bin/env bash
# Board sign-in help. Run on the droplet as root:   bash /opt/conviction/tools/reset_login.sh
#   1. shows the board user name
#   2. lists failed sign-ins (401) from the last hour, from the board server and Caddy logs, with the URL and the reason
#   3. sets a new random 32-character password, restarts the boards, and tests it on /v2, /v3 and their data calls
#   4. shows the new password once, at the very end
# Add --keep-password to do 1, 2 and 3's tests without changing the password (the tests then only check that sign-in is required).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root."; exit 1; }
KEEP=""; [ "${1:-}" = "--keep-password" ] && KEEP=1
DIR=/opt/conviction; cd "$DIR"
getv(){ grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
setv(){ grep -vE "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
NAME=$(awk '/^[a-z0-9.-]+\.[a-z]+ *\{/{print $1; exit}' /etc/caddy/Caddyfile 2>/dev/null || true)
USERNAME="$(getv BOARD_USER)"; USERNAME="${USERNAME:-bilal}"
PORT="$(getv PORT)"; PORT="${PORT:-80}"

say "1/4 User name"
echo "   $USERNAME     (capital letters and spaces around it are ignored)"
echo "   Address:  https://${NAME:-<no domain set>}/v2  and  /v3"

say "2/4 Failed sign-ins in the last hour"
SINCE=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)
echo "Board server (reason for each refusal; repeats of the same one are shown once a minute):"
if [ -f /var/log/conviction.log ]; then
  awk -v s="$SINCE" '$1>=s && /auth: 401/' /var/log/conviction.log | tail -40 | sed 's/^/   /'
  awk -v s="$SINCE" '$1>=s && /auth: 401/' /var/log/conviction.log | grep -q . || echo "   none logged (the reason log starts with this update)"
fi
echo "Caddy (every 401 by URL and visitor IP):"
if [ -f /var/log/caddy/access.log ]; then
  python3 - "$SINCE" <<'PY'
import json,sys,datetime,collections
since=datetime.datetime.fromisoformat(sys.argv[1]).replace(tzinfo=datetime.timezone.utc).timestamp()
c=collections.Counter()
for ln in open('/var/log/caddy/access.log', errors='replace'):
    try: d=json.loads(ln)
    except Exception: continue
    if d.get('status')==401 and d.get('ts',0)>=since:
        r=d.get('request',{}); c[(r.get('client_ip') or r.get('remote_ip'), r.get('method'), r.get('uri','').split('?')[0])]+=1
for (ip,m,u),n in c.most_common(40): print(f"   {n:4d} x  {m} {u}  from {ip}")
if not c: print("   none")
PY
else
  echo "   no Caddy request log yet (it starts after: bash $DIR/tools/https.sh ${NAME:-<your domain>})"
fi

if [ -n "$KEEP" ]; then say "3/4 Checking sign-in (password kept)"; else say "3/4 New password"; fi
if [ -z "$KEEP" ]; then
  NEWPW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
  setv BOARD_PASSWORD "$NEWPW"
  systemctl restart conviction
  for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 1; done
fi
if [ -n "$NAME" ]; then
  chk(){ local what="$1" url="$2" extra="${3:-}"; local code
    code=$(curl -s -o /dev/null -m 4 -w '%{http_code}' $extra "https://$NAME$url" || true)
    printf '   %-34s %s\n' "$what" "$code"; }
  echo "   Without a password (should be 401):"
  chk "/v3 page" /v3
  chk "/api/db/v3/v3trades (data)" /api/db/v3/v3trades
  if [ -z "$KEEP" ]; then
    echo "   With the new password (should be 200):"
    AUTH="-u ${USERNAME}:${NEWPW}"
    chk "/v2 page" /v2 "$AUTH"
    chk "/v3 page" /v3 "$AUTH"
    chk "/api/db/v2/paper (data)" /api/db/v2/paper "$AUTH"
    chk "/api/db/v3/v3trades (data)" /api/db/v3/v3trades "$AUTH"
    chk "/api/events/v3 (live updates)" /api/events/v3 "$AUTH"
    code=$(curl -s -o /dev/null -m 6 -w '%{http_code}' -u "${USERNAME}:${NEWPW}" -H 'content-type: application/json' \
      -d '{"server":"host:massive","tool":"call_api","input":{"path":"/v1/marketstatus/now","params":{}}}' "https://$NAME/api/mcp" || true)
    printf '   %-34s %s\n' "/api/mcp (market data)" "$code"
    printf '   %-34s %s\n' "old address http://<ip>/v3" "$(curl -s -o /dev/null -m 4 -w '%{http_code} -> %{redirect_url}' "http://$(curl -s -4 https://api.ipify.org)/v3" || true)"
  fi
fi

if [ -z "$KEEP" ]; then
  say "4/4 Your new password (shown once)"
  echo "   User name: $USERNAME"
  echo "   Password:  $NEWPW"
  echo
  echo "   Save it in your password manager now. Then, in your browser, delete the old saved password for"
  echo "   ${NAME:-this site} (or use a private window) so it stops sending the old one."
  echo "   To see it again later:  grep '^BOARD_PASSWORD=' $DIR/.env"
  unset NEWPW
fi
