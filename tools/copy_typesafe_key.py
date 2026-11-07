#!/usr/bin/env python3
"""Mac only: copy the TypeSafe (Jev) API key from the Claude app's settings to the clipboard, without showing it.
Then paste it into the hidden prompt of tools/jev_setup.sh in the droplet console, and copy something else afterwards.
   python3 ~/conviction-cloud/tools/copy_typesafe_key.py
"""
import json
import os
import subprocess

CFG = os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json")


def find(o):
    if isinstance(o, dict):
        s = (o.get("mcpServers") or {}).get("evaluate") if isinstance(o.get("mcpServers"), dict) else None
        if s:
            return s
        for v in o.values():
            r = find(v)
            if r:
                return r
    return None


try:
    s = find(json.load(open(CFG)))
    key = ((s or {}).get("env") or {}).get("TYPESAFE_API_KEY", "")
except OSError:
    key = ""
if not key:
    print("No TypeSafe key found in the Claude app's settings. Get one at https://console.typesafe.ai instead.")
else:
    subprocess.run(["pbcopy"], input=key.encode(), check=True)
    print(f"Copied your TypeSafe key ({len(key)} characters) to the clipboard. It was not shown.")
