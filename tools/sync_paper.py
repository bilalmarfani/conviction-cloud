#!/usr/bin/env python3
"""Read Conviction Engine v2's paper plays from the cloud server, for copying into the
Claude artifact's "paper" collection. Read-only: it never changes anything on the server.

Setup on the Mac (once):
  ~/.conviction/server       the server address, e.g. http://203.0.113.5
  ~/.conviction/export_key   the EXPORT_KEY from /opt/conviction/.env on the server (chmod 600)

  python3 sync_paper.py              JSON of plays that are new or changed since the last sync
  python3 sync_paper.py --full       every play from the last 14 days, whether or not it changed
  python3 sync_paper.py --mark ID:H ..  record that these plays (id:h pairs from the output) were written to the artifact

Output: {"ok": true, "today": "YYYY-MM-DD", "changed": [{"id": ..., "h": ..., "data": {...}}, ...]}
     or {"ok": false, "error": "..."}  (the key is never printed)
"""
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

DIR = os.path.expanduser(os.environ.get("CONVICTION_DIR", "~/.conviction"))
STATE = os.path.join(DIR, "synced.json")
DAYS = 14


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


def fetch(today):
    server, key = read("server").rstrip("/"), read("export_key")
    if not server or not key:
        out({"ok": False, "error": f"missing {DIR}/server or {DIR}/export_key"})
    since = (dt.date.fromisoformat(today) - dt.timedelta(days=DAYS)).isoformat()
    req = urllib.request.Request(f"{server}/export/v2?since={since}", headers={"x-export-key": key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        out({"ok": False, "error": f"server answered HTTP {e.code}" + (" (export key not accepted)" if e.code == 403 else "")})
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        out({"ok": False, "error": f"could not reach the server: {getattr(e, 'reason', e)}"})
    return (body.get("collections") or {}).get("paper") or {}


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
    paper = fetch(today)
    changed = [{"id": i, "h": digest(d), "data": d} for i, d in sorted(paper.items())
               if isinstance(d, dict) and (full or state.get(i) != digest(d))]
    out({"ok": True, "today": today, "changed": changed})


if __name__ == "__main__":
    main(sys.argv[1:])
