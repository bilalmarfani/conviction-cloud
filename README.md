# Conviction Cloud

Runs **Conviction Board v3** and **Conviction Engine v2** around the clock on a small Ubuntu server, so the paper accounts keep trading when your Mac is asleep. Paper trading only: nothing here connects to a broker or places a real order.

## Install (one paste)

On DigitalOcean open your droplet → **Access** → **Launch Droplet Console**, then paste:

```
curl -fsSL https://raw.githubusercontent.com/bilalmarfani/conviction-cloud/main/install.sh | bash
```

It installs everything, asks for your Massive API key (massive.com → Dashboard → API Keys) and a password for the boards, then prints the address to open. Running it again updates the software and keeps your keys and trades.

## How it works

| Piece | What it does |
|---|---|
| `server.mjs` | Web server, database (JSON files in `data/`), market data, and the always-on engine |
| Massive MCP server | The same Massive data server the Claude app used, run here with your key |
| Engine | A headless Chromium keeps one copy of each board open. That copy is the only one that records paper trades |
| Your browser | Opens `http://<server-ip>/v3` or `/v2` with your password. Shows everything live and plays alerts, never records trades |
| `feeds/` | Earnings dates (TradingView) and crowd lean (Liquid), refreshed by Claude's morning task; the server picks them up within 15 minutes |
| Updates | The server checks this repo every 15 minutes. Data files apply at once; code changes apply outside market hours |

Keys and the password live only in `/opt/conviction/.env` on the server (never in this repo).

## Useful commands (in the droplet console)

```
systemctl status conviction        # is it running
tail -f /var/log/conviction.log    # live log
systemctl restart conviction       # restart
nano /opt/conviction/.env          # change keys or password, then restart
```

Status page: `http://<server-ip>/` (same password).

## Not available on the server

- **Jev news score** needs an Anthropic API key (optional; the installer asks). Without it v2 shows TECH GO and 5-MIN plays but no GO IN, and v3 trades exactly as before (Jev is off by default there).
- **Webull sync** (v2) and **Slack alerts** need the Claude app.
