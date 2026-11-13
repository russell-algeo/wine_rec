"""Execute the stalled-delivery reconciliation Lua against in-memory fakeredis.
No Redis server, credentials or network. Test-only deps as test-redis-terminal.py.
"""
import json, re
from pathlib import Path
import fakeredis

src = (Path(__file__).resolve().parent.parent / "src/store/stall-recovery.ts").read_text()
lua = re.search(r"RECONCILE_STALLED_JOB_LUA = `([\s\S]*?)`;", src).group(1)
expected = json.dumps({"id": "j", "status": "processing", "candidates": [], "recommendations": []})
nxt = json.dumps({"id": "j", "status": "failed", "candidates": [], "recommendations": []})

def fresh(ttl=True):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    if ttl: r.set("job", expected, px=5_000_000)
    else: r.set("job", expected)
    return r

r = fresh()
assert r.eval(lua, 1, "job", expected, nxt) == "applied"
assert r.get("job") == nxt, "raw JSON shape preserved exactly (empty arrays stay arrays)"
assert 0 < r.pttl("job") <= 5_000_000, "TTL kept, not extended"
assert r.eval(lua, 1, "job", expected, nxt) == "changed", "second apply refuses"

r = fresh(); r.set("job", expected.replace("processing", "completed"), px=1000)
assert r.eval(lua, 1, "job", expected, nxt) == "changed"
assert fakeredis.FakeStrictRedis(decode_responses=True).eval(lua, 1, "job", expected, nxt) == "missing"
r = fresh(ttl=False)
assert r.eval(lua, 1, "job", expected, nxt) == "no-ttl" and r.get("job") == expected
print("stall recovery Lua: 6 checks passed")
