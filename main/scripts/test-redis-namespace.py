"""Actual Lua collision proof on disposable loopback Valkey, never hosted Redis.
Uses the pinned Python Redis dependency already required by test-redis-terminal.py.
Requires VALKEY_SERVER_BIN; no silent skip or remote endpoint fallback.
"""
import json, os, re, secrets, socket, subprocess, tempfile, time
from pathlib import Path
import redis

source = (Path(__file__).resolve().parent.parent / 'src/store/job-store.ts').read_text()
scripts = dict(re.findall(r'const (\w+) = redis\.createScript<[^>]+>\(`([\s\S]*?)`\);', source))
assert len(scripts) == 5
binary = os.environ['VALKEY_SERVER_BIN']
checks = []
namespace = 'preview:local-proof:'
base = 'job:same-id'
suffixes = ['', ':worker:0', ':candidate:c', ':candidate-queue', ':candidate-leases', ':progress', ':recommendations']
with tempfile.TemporaryDirectory(prefix='wine-namespace-proof-') as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    password = secrets.token_hex(24)
    config = Path(directory) / 'valkey.conf'
    config.write_text(f'bind 127.0.0.1\nport {port}\nrequirepass {password}\nsave ""\nappendonly no\ndir {directory}\n')
    config.chmod(0o600)
    process = subprocess.Popen([binary, str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = redis.Redis(host='127.0.0.1', port=port, password=password, socket_timeout=2, socket_connect_timeout=2)
    try:
        for attempt in range(100):
            try:
                if r.ping(): break
            except redis.ConnectionError:
                time.sleep(.02)
        else: raise AssertionError('Local-only Valkey failed to start')
        # Production is synthetic. Identical IDs intentionally test collisions.
        for suffix in suffixes:
            r.set(base + suffix, 'production-sentinel:' + suffix, ex=600)
        production = {key: (r.dump(key), r.pttl(key)) for key in [base + s for s in suffixes]}
        started = time.monotonic()
        def untouched(label):
            for key, (value, ttl) in production.items():
                assert r.dump(key) == value, (label, 'Production value changed', key)
                remaining = r.pttl(key)
                elapsed = (time.monotonic() - started) * 1000
                assert ttl - elapsed - 100 <= remaining <= ttl, (label, 'Production TTL changed', key)
            checks.append(label)
        def key(suffix=''): return namespace + base + suffix
        def seed():
            # Exact known local fixture keys, never SCAN, FLUSHDB or wildcard deletion.
            r.delete(*[key(suffix) for suffix in suffixes])
            r.set(key(), json.dumps(dict(id='same-id', status='processing', queueMessageId=None, errorMessage=None, updatedAt='old')), ex=60)
            r.set(key(':candidate:c'), json.dumps(dict(candidateId='c', status='queued', leaseOwner=None, leaseExpiresAt=None, attemptCount=0)), ex=60)
            r.set(key(':progress'), json.dumps(dict(candidateCount=1, completedCount=0, failedCount=0)), ex=60)
            r.rpush(key(':candidate-queue'), 'c'); r.expire(key(':candidate-queue'),60)
        def run(name, keys, args): return r.eval(scripts[name], len(keys), *keys, *args)
        def claim(owner='owner'):
            return run('claimNextJobCandidateScript', [key(':candidate-queue'),key(':candidate-leases'),key()], [key(':candidate:'),owner,str(int(time.time()*1000)),'75000','now','60'])
        def complete(owner='owner'):
            return json.loads(run('completeJobCandidateScript',[key(':candidate-leases'),key(':candidate:c'),key(':recommendations'),key(':progress'),key()],[owner,json.dumps(dict(candidateId='c',fitScore=50,matchConfidence=0,profile=None,status='unmatched')),'now','60']))
        seed(); untouched('seed duplicate IDs')
        assert run('updateJobScript',[key()],[json.dumps(dict(errorMessage='preview-only')),'now','60']) == 1
        untouched('update Lua scoped')
        assert claim() == b'c'; untouched('claim Lua and dynamically derived candidate key scoped')
        assert complete()['updated']; untouched('completion Lua scoped')
        assert not complete()['updated']; untouched('duplicate completion remains idempotent')
        assert run('updateJobScript',[key()],[json.dumps(dict(status='processing')),'now','60']) == 0
        untouched('terminal update monotonic')
        seed(); assert claim() == b'c'
        assert run('requeueJobCandidateScript',[key(':candidate-queue'),key(':candidate-leases'),key(':candidate:c'),key()],['owner','retry','now','60']) == 1
        untouched('requeue Lua scoped')
        assert claim('owner-two') == b'c'
        failure = json.loads(run('failJobCandidateScript',[key(':candidate-leases'),key(':candidate:c'),key(':progress'),key()],['owner-two','synthetic failure','now','60']))
        assert failure['updated'] and failure['jobStatus'] == 'failed'; untouched('failure Lua scoped')
        seed(); assert claim() == b'c'
        run('updateJobScript',[key()],[json.dumps(dict(status='canceled')),'now','60'])
        assert not complete()['updated']; assert claim('late') is None
        untouched('cancellation blocks late completions and claims')
        r.delete(key(':candidate-queue'),key(':candidate-leases')); untouched('queue cleanup exact Preview keys')
        r.delete(key(':candidate-queue'),key(':candidate-leases'),key(':recommendations'),key(':progress')); untouched('state cleanup exact Preview keys')
        r.delete(*[key(suffix) for suffix in suffixes]); untouched('fixture cleanup leaves all Production values and TTLs untouched')
        # This demonstrates the explicitly accepted residual risk, not a safe ACL:
        # the same credential CAN see production keys even with a Preview prefix.
        assert r.get(base) == b'production-sentinel:'
        checks.append('shared credential remains full authority: namespace is not access isolation')
        print(json.dumps(dict(passed=len(checks), engine=r.info('server').get('valkey_version',r.info('server').get('redis_version')), checks=checks)))
    finally:
        r.close(); process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
