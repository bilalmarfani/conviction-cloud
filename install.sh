#!/usr/bin/env bash
# Conviction Cloud installer for a fresh Ubuntu droplet (22.04 or 24.04). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/bilalmarfani/conviction-cloud/main/install.sh | bash
# Safe to run again: it updates the software and keeps your keys, password and paper trades.
set -euo pipefail
REPO="https://github.com/bilalmarfani/conviction-cloud.git"
DIR=/opt/conviction
MASSIVE_REF="1e161a8c50b69bd467b092e0721e30908ab94eb6"   # Massive's official MCP server, pinned
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn(){ printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Please run as root (on DigitalOcean the web Console logs you in as root)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "1/7 Updating the system and installing basics"
apt-get update -y -q
apt-get install -y -q git curl ca-certificates ufw >/dev/null

# Chromium needs memory: add a 2 GB swap file on small droplets
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3500 ] && ! swapon --show | grep -q /swapfile; then
  say "Adding 2 GB of swap (this droplet has ${MEM_MB} MB of memory)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "2/7 Installing Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
fi
node -v

say "3/7 Installing the Massive market-data server"
if ! command -v uv >/dev/null && [ ! -x /root/.local/bin/uv ]; then curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; fi
export PATH="/root/.local/bin:$PATH"
uv tool install --force "mcp_massive @ git+https://github.com/massive-com/mcp_massive@${MASSIVE_REF}" >/dev/null
MASSIVE_BIN=$(command -v mcp_massive)
echo "$MASSIVE_BIN"

say "4/7 Getting the board software"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else git clone -q "$REPO" "$DIR"; fi
cd "$DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null

say "5/7 Installing the headless browser that keeps the boards running"
npx --yes playwright install --with-deps chromium >/dev/null

say "6/7 Your keys and password"
touch .env; chmod 600 .env
getv(){ grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
setv(){ grep -vE "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
ask(){ local prompt="$1" var; read -r -p "$prompt" var </dev/tty; echo "$var"; }
asks(){ local prompt="$1" var; read -r -s -p "$prompt" var </dev/tty; echo >&2; echo "$var"; }

KEY=$(getv MASSIVE_API_KEY)
while :; do
  if [ -z "$KEY" ]; then KEY=$(asks "Paste your Massive API key (it will not show on screen), then press Enter: "); fi
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://api.massive.com/v1/marketstatus/now?apiKey=${KEY}" || true)
  if [ "$CODE" = 200 ]; then echo "Massive key works."; break; fi
  warn "Massive did not accept that key (HTTP $CODE). Copy it again from massive.com → Dashboard → API Keys."; KEY=""
done
setv MASSIVE_API_KEY "$KEY"

PASS=$(getv BOARD_PASSWORD)
if [ -z "$PASS" ]; then
  while :; do
    PASS=$(asks "Choose a password for opening your boards (at least 10 characters): ")
    [ ${#PASS} -ge 10 ] || { warn "Too short."; continue; }
    P2=$(asks "Type it again: "); [ "$PASS" = "$P2" ] && break; warn "They did not match."
  done
fi
setv BOARD_PASSWORD "$PASS"
[ -n "$(getv BOARD_USER)" ] || setv BOARD_USER bilal
if [ -z "$(getv ANTHROPIC_API_KEY)" ] && [ -z "$(getv JEV_ASKED)" ]; then
  echo
  echo "Optional: an Anthropic API key turns on the Jev news score on the server (v2 needs it for GO IN; v3 shows it)."
  AK=$(asks "Paste an Anthropic API key, or just press Enter to skip: ")
  [ -n "$AK" ] && setv ANTHROPIC_API_KEY "$AK"
  setv JEV_ASKED 1
fi
setv MASSIVE_CMD "$MASSIVE_BIN"
setv PORT 80

say "7/7 Starting the service"
cat > /etc/systemd/system/conviction.service <<UNIT
[Unit]
Description=Conviction boards (paper trading)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) server.mjs
Restart=always
RestartSec=5
Environment=HOME=/root
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=append:/var/log/conviction.log
StandardError=append:/var/log/conviction.log

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/logrotate.d/conviction <<'ROT'
/var/log/conviction.log { weekly rotate 4 compress missingok notifempty copytruncate }
ROT
systemctl daemon-reload
systemctl enable conviction >/dev/null 2>&1
systemctl restart conviction

if ufw status | grep -q "Status: active"; then ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; fi

sleep 8
IP=$(curl -s -4 https://api.ipify.org || hostname -I | awk '{print $1}')
if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/healthz | grep -q 200; then
  say "Done. Your boards are running."
  echo
  echo "   Open:      http://${IP}/"
  echo "   User name: $(getv BOARD_USER)"
  echo "   Password:  the one you just chose"
  echo
  echo "   They keep running when this window is closed. Logs: tail -f /var/log/conviction.log"
else
  warn "The service did not answer yet. Run:  systemctl status conviction  and  tail -50 /var/log/conviction.log"
fi
