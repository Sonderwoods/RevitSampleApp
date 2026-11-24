#!/usr/bin/env python3
"""
Write the built-in DHM API key into Web/js/config.js (used by CI with the GitHub secret DHM_API_KEY).

    DHM_API_KEY=... python3 tools/inject_dhm_key.py      # key from the environment
    python3 tools/inject_dhm_key.py --key ...             # or explicit

Does nothing (and succeeds) when no key is given, so forks and PR builds without the secret still build.
"""
import argparse
import json
import os
import pathlib
import re
import sys

CONFIG = pathlib.Path(__file__).resolve().parent.parent / "Web" / "js" / "config.js"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("DHM_API_KEY", ""))
    ap.add_argument("--file", default=str(CONFIG))
    a = ap.parse_args()
    key, path = a.key.strip(), pathlib.Path(a.file)
    if not key:
        print("DHM_API_KEY not set: leaving the built-in key empty (users paste their own).")
        return
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(r"export const DHM_API_KEY = .*?;", lambda _: f"export const DHM_API_KEY = {json.dumps(key)};", text)
    if n != 1:
        sys.exit(f"Could not find the DHM_API_KEY line in {path}")
    path.write_text(new, encoding="utf-8")
    print(f"Built-in DHM key written to {path} ({len(key)} characters).")


if __name__ == "__main__":
    main()
