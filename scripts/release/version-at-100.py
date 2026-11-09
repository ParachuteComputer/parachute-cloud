"""stdin: `wrangler deployments status --json`. stdout: the version id at 100%, or nothing (unreadable or split)."""
import json, sys
t = sys.stdin.read()
try:
    v = json.loads(t[t.find("{"):]).get("versions") or []
except Exception:
    v = []
if len(v) == 1 and v[0].get("percentage", 100) == 100:
    print(v[0].get("version_id", ""))
