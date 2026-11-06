#!/usr/bin/env bash
# Put the boards behind HTTPS with Caddy (free Let's Encrypt certificate, renewed automatically). Run on the droplet as root:
#   bash /opt/conviction/tools/https.sh                 uses <your-ip>.sslip.io, a free name that points at this droplet
#   bash /opt/conviction/tools/https.sh boards.example.com   uses your own domain (point its A record at this droplet first)
# Safe to run again. Afterwards the boards are at https://<name>/ (same user name and password); plain http:// redirects to https://.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root."; exit 1; }
DIR=/opt/conviction
IP=$(curl -s -4 https://api.ipify.org || hostname -I | awk '{print $1}')
NAME="${1:-${IP//./-}.sslip.io}"
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "1/4 Installing Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q >/dev/null && apt-get install -y -q caddy >/dev/null
fi
caddy version

say "2/4 Moving the board server behind Caddy (it now listens only on this machine, port 8080)"
cd "$DIR"
setv(){ grep -vE "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
setv PORT 8080
setv HOST 127.0.0.1
git -C "$DIR" pull --ff-only -q || true
systemctl restart conviction

say "3/4 Starting HTTPS for $NAME"
cat > /etc/caddy/Caddyfile <<CADDY
$NAME {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
CADDY
if ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

say "4/4 Checking"
ok=""
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$NAME/healthz" || true)
  [ "$code" = 200 ] && { ok=1; break; }; sleep 3
done
if [ -n "$ok" ]; then
  say "Done. Open https://$NAME/  (same user name and password as before)"
  echo "   On the Mac, the paper sync should now use: https://$NAME"
else
  echo "HTTPS is not answering yet. Check:  journalctl -u caddy -n 50 --no-pager   and   systemctl status conviction"
  exit 1
fi
