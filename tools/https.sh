#!/usr/bin/env bash
# Put the boards behind HTTPS with Caddy (free Let's Encrypt certificate, renewed automatically). Run on the droplet as root:
#   bash /opt/conviction/tools/https.sh boards.example.com                 your own domain (point its A record at this droplet first)
#   bash /opt/conviction/tools/https.sh boards.example.com --new-password  same, and replace the board password with a new random one
#   bash /opt/conviction/tools/https.sh                                    no domain: uses <your-ip>.sslip.io, a free name for this droplet
# Safe to run again. Afterwards:
#   https://<name>/            the boards, behind the board user name and password (checked by the board server)
#   http://<name>/...          redirects to https://<name>/... (same path)
#   http://<droplet IP>/...    redirects to https://<name>/... (same path); any other name on port 80 does the same
#   https://<droplet IP>/      refused: there is no certificate for the bare IP, so the connection is closed
# The board password is replaced with a new random 32-character one when it is shorter than 20 characters or --new-password is given.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root."; exit 1; }
DIR=/opt/conviction
NEWPW=""; NAME=""
for a in "$@"; do case "$a" in --new-password) NEWPW=1 ;; -*) echo "Unknown option $a"; exit 1 ;; *) NAME="$a" ;; esac; done
IP=$(curl -s -4 https://api.ipify.org || hostname -I | awk '{print $1}')
NAME="${NAME:-${IP//./-}.sslip.io}"
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "1/5 Installing Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q >/dev/null && apt-get install -y -q caddy >/dev/null
fi
caddy version

say "2/5 Board server behind Caddy (listens only on this machine, port 8080)"
cd "$DIR"
getv(){ grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
setv(){ grep -vE "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
setv PORT 8080
setv HOST 127.0.0.1
git -C "$DIR" pull --ff-only -q || true

say "3/5 Board password"
PW="$(getv BOARD_PASSWORD)"
if [ -n "$NEWPW" ] || [ ${#PW} -lt 20 ]; then
  PW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
  setv BOARD_PASSWORD "$PW"
  echo "A new random password was set. Save it in your password manager now; it is not shown again."
  echo "To see it later: grep '^BOARD_PASSWORD=' /opt/conviction/.env"
  echo
  echo "   User name: $(getv BOARD_USER)"
  echo "   Password:  $PW"
else
  echo "Kept the current password (${#PW} characters). Run with --new-password to replace it."
fi
unset PW
systemctl restart conviction

say "4/5 HTTPS for $NAME; the bare IP redirects to it"
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
cat > /etc/caddy/Caddyfile.new <<CADDY
# The boards. Sign-in (Basic auth) is checked by the board server behind this proxy.
$NAME {
	encode gzip
	reverse_proxy 127.0.0.1:8080
	# request log (passwords are never written: Caddy hides the Authorization header). See tools/reset_login.sh
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format json
	}
}

# Plain http to the droplet's IP address, or any other name: send it to the real address with the same path and query.
# https to the bare IP has no certificate here, so those connections are refused.
http:// {
	redir https://$NAME{uri} permanent
}
CADDY
if ! caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  cat /tmp/caddy-validate.log; rm -f /etc/caddy/Caddyfile.new
  echo "The new Caddy settings did not validate; the old ones are still in use."; exit 1
fi
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
if ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "5/5 Checking"
ok=""
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$NAME/healthz" || true)
  [ "$code" = 200 ] && { ok=1; break; }; sleep 3
done
[ -n "$ok" ] || { echo "HTTPS is not answering yet. Check:  journalctl -u caddy -n 50 --no-pager   and   systemctl status conviction"; exit 1; }
echo "https://$NAME/healthz            -> 200"
echo "https://$NAME/v2 without password -> $(curl -s -o /dev/null -w '%{http_code}' "https://$NAME/v2") (401 = sign-in required)"
echo "http://$IP/v2?x=1             -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$IP/v2?x=1")"
echo "https://$IP/                  -> $(curl -s -k -m 5 -o /dev/null -w '%{http_code}' "https://$IP/" || true) (000 = refused)"
say "Done. Open https://$NAME/"
