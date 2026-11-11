"""Execute the actual Redis Lua transitions against in-memory fakeredis + Lua.
No Redis server, sockets, credentials, or network requests are used.
Test-only dependencies: fakeredis[lua]==2.32.1, redis==8.1.0, lupa==2.8,
sortedcontainers==2.4.0. They are not production dependencies.
"""
import json
import re
from pathlib import Path
import fakeredis

source = (Path(__file__).resolve().parent.parent / "src/store/job-store.ts").read_text()
scripts = dict(re.findall(r"const (\w+) = redis\.createScript<[^>]+>\(`([\s\S]*?)`\);", source))
assert len(scripts) == 5, sorted(scripts)
checks = []

def fresh(status="processing"):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    job = dict(id="j", status=status, queueMessageId="m", errorMessage="original", updatedAt="old")
    r.set("job", json.dumps(job))
    r.set("candidate", json.dumps(dict(candidateId="c", status="processing", leaseOwner="worker-0", leaseExpiresAt="1")))
    r.set("progress", json.dumps(dict(candidateCount=1, completedCount=0, failedCount=0)))
    r.zadd("lease", {"c": 1})
    return r

def run(r, name, keys, args):
    return r.eval(scripts[name], len(keys), *keys, *args)

def read(r, key):
    return json.loads(r.get(key))

for terminal in ["failed", "canceled", "completed"]:
    r = fresh(terminal)
    assert run(r, "updateJobScript", ["job"], [json.dumps(dict(status="processing", errorMessage=None)), "new", "86400"]) == 0
    assert read(r, "job")["status"] == terminal and read(r, "job")["errorMessage"] == "original"
    checks.append(f"{terminal}: stale worker cannot revive job")
    r.rpush("queue", "c")
    assert not run(r, "claimNextJobCandidateScript", ["queue", "lease", "job"], ["candidate:", "worker-0", "1000", "75000", "now", "86400"])
    assert r.llen("queue") == 1
    checks.append(f"{terminal}: no fresh candidate claim")
    out = json.loads(run(r, "completeJobCandidateScript", ["lease", "candidate", "recs", "progress", "job"], ["worker-0", json.dumps(dict(candidateId="c")), "now", "86400"]))
    assert out["updated"] is False and out["jobStatus"] == terminal
    assert r.llen("recs") == 0 and read(r, "progress")["completedCount"] == 0
    checks.append(f"{terminal}: no late completion or recommendation write")
    assert run(r, "requeueJobCandidateScript", ["queue", "lease", "candidate", "job"], ["worker-0", "temporary", "now", "86400"]) == 0
    assert r.llen("queue") == 1
    checks.append(f"{terminal}: no candidate requeue")
    out = json.loads(run(r, "failJobCandidateScript", ["lease", "candidate", "progress", "job"], ["worker-0", "late failure", "now", "86400"]))
    assert out["updated"] is False and read(r, "job")["errorMessage"] == "original"
    checks.append(f"{terminal}: preserve first terminal result")

r = fresh()
assert run(r, "updateJobScript", ["job"], [json.dumps(dict(status="failed", errorMessage="access blocked", queueMessageId=None)), "new", "86400"]) == 1
assert run(r, "updateJobScript", ["job"], [json.dumps(dict(status="processing")), "later", "86400"]) == 0
assert read(r, "job")["status"] == "failed"
checks.append("block transition wins over stale processing write")

r = fresh()
out = json.loads(run(r, "completeJobCandidateScript", ["lease", "candidate", "recs", "progress", "job"], ["worker-0", json.dumps(dict(candidateId="c")), "now", "86400"]))
assert out["updated"] is True and out["jobStatus"] == "completed" and r.llen("recs") == 1
checks.append("ordinary active completion still succeeds")

r = fresh()
assert run(r, "requeueJobCandidateScript", ["queue", "lease", "candidate", "job"], ["worker-0", "temporary", "now", "86400"]) == 1
assert r.llen("queue") == 1 and read(r, "candidate")["status"] == "queued"
checks.append("ordinary active transient requeue still succeeds")

r = fresh()
out = json.loads(run(r, "failJobCandidateScript", ["lease", "candidate", "progress", "job"], ["worker-0", "ordinary failure", "now", "86400"]))
assert out["updated"] is True and out["jobStatus"] == "failed"
checks.append("ordinary active failure still succeeds")

print(json.dumps(dict(passed=len(checks), checks=checks)))
