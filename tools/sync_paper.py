#!/usr/bin/env python3
"""Read Conviction Engine v2's paper plays ("paper") and managed test plays ("managed") from the cloud server,
for copying into the same collections of the Claude artifact. Read-only: it never changes anything on the server.

Setup on the Mac (once):
  ~/.conviction/server       the server address, e.g. http://203.0.113.5
  ~/.conviction/export_key   the EXPORT_KEY from /opt/conviction/.env on the server (chmod 600)

  python3 sync_paper.py              JSON of plays that are new or changed since the last sync
  python3 sync_paper.py --full       every play from the last 14 days, whether or not it changed
  python3 sync_paper.py --mark KEY:H ..  record that these docs (key:h pairs from the output) were written to the artifact

Output: {"ok": true, "today": "YYYY-MM-DD", "changed": [{"coll": "paper"|"managed", "id": ..., "key": ..., "h": ..., "data": {...}}, ...]}
  write each one to the artifact at <coll>/<id>; key is what --mark takes
     or {"ok": false, "error": "..."}  (the key is never printed)
"""
import datetime as dt
import hashlib
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

DIR = os.path.expanduser(os.environ.get("CONVICTION_DIR", "~/.conviction"))
STATE = os.path.join(DIR, "synced.json")
DAYS = 14
COLLS = ("paper", "managed")


def out(obj):
    print(json.dumps(obj, separators=(",", ":"), sort_keys=True))
    sys.exit(0 if obj.get("ok") else 1)


def read(name):
    try:
        with open(os.path.join(DIR, name)) as f:
            return f.read().strip()
    except OSError:
        return ""


def digest(data):
    return hashlib.sha1(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def tls():
    # python.org Python on macOS ships without trusted certificates until "Install Certificates" is run; fall back to macOS's list
    ctx = ssl.create_default_context()
    if not ctx.cert_store_stats().get("x509_ca") and os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


def fetch(today):
    server, key = read("server").rstrip("/"), read("export_key")
    if not server or not key:
        out({"ok": False, "error": f"missing {DIR}/server or {DIR}/export_key"})
    since = (dt.date.fromisoformat(today) - dt.timedelta(days=DAYS)).isoformat()
    req = urllib.request.Request(f"{server}/export/v2?since={since}", headers={"x-export-key": key})
    try:
        with urllib.request.urlopen(req, timeout=20, context=tls()) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        out({"ok": False, "error": f"server answered HTTP {e.code}" + (" (export key not accepted)" if e.code == 403 else "")})
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        out({"ok": False, "error": f"could not reach the server: {getattr(e, 'reason', e)}"})
    cols = body.get("collections") or {}
    return {c: cols.get(c) or {} for c in COLLS}


def main(argv):
    today = dt.datetime.now(ZoneInfo("America/Chicago")).date().isoformat()
    state = load_state()
    if argv[:1] == ["--mark"]:
        marked = []
        for pair in " ".join(argv[1:]).replace(",", " ").split():
            i, _, h = pair.rpartition(":")
            if i and len(h) == 40:
                state[i] = h; marked.append(i)
        os.makedirs(DIR, exist_ok=True)
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, STATE)
        out({"ok": True, "marked": marked})
    full = "--full" in argv
    docs = fetch(today)
    changed = []
    for c in COLLS:
        for i, d in sorted(docs[c].items()):
            key = i if c == "paper" else f"{c}/{i}"   # paper keys stay plain ids, as already recorded in synced.json
            if isinstance(d, dict) and (full or state.get(key) != digest(d)):
                changed.append({"coll": c, "id": i, "key": key, "h": digest(d), "data": d})
    out({"ok": True, "today": today, "changed": changed})


if __name__ == "__main__":
    main(sys.argv[1:])
