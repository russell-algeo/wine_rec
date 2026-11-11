"""Actual budget Lua on disposable loopback Valkey. No hosted credentials/data.
Requires VALKEY_SERVER_BIN and the existing test-only Python redis dependency.
"""
import concurrent.futures, json, os, re, secrets, socket, subprocess, tempfile, time
from pathlib import Path
import redis

source = (Path(__file__).resolve().parent.parent / 'src/preview-publish-budget.ts').read_text()
script = re.search(r'export const reservePreviewPublicationLua = `([\s\S]*?)`;', source).group(1)
checks = []
with tempfile.TemporaryDirectory(prefix='wine-budget-proof-') as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    password = secrets.token_hex(24)
    config = Path(directory) / 'valkey.conf'
    config.write_text(f'bind 127.0.0.1\nport {port}\nrequirepass {password}\nsave ""\nappendonly no\ndir {directory}\n')
    config.chmod(0o600)
    process = subprocess.Popen([os.environ['VALKEY_SERVER_BIN'], str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = redis.Redis(host='127.0.0.1', port=port, password=password, socket_timeout=2, socket_connect_timeout=2)
    try:
        for _ in range(100):
            try:
                if r.ping(): break
            except redis.ConnectionError: time.sleep(.02)
        else: raise AssertionError('Local Valkey failed to start')
        deadline = int(time.time()) + 3600
        def permit(mode, job): return json.dumps([mode, job], separators=(',', ':'))
        def run(key, job='j', mode='coordinator', limit=6, until=deadline):
            return r.eval(script, 1, key, limit, until, permit(mode,job), permit('coordinator',job) if mode=='worker' else '')
        production = ['job:j', 'qstash-smoke-budget:v1', 'preview:other:qstash-smoke-budget:v1']
        for key in production: r.set(key, 'untouched', ex=600)
        before = {key: r.dump(key) for key in production}
        def ok(label):
            assert all(r.dump(key)==value and 0 < r.ttl(key) <= 600 for key,value in before.items())
            checks.append(label)
        key = 'preview:proof:qstash-smoke-budget:v1'
        assert run(key) == 1 and run(key, mode='worker') == 1
        ok('coordinator and sole worker share two permits')
        assert run(key) == 0 and run(key, mode='worker') == 0
        assert r.hget(key,'spent') == b'2'
        ok('duplicate/replayed publications cannot spend or publish again')
        assert run(key, job='orphan', mode='worker') == -4
        ok('worker requires its coordinator permit')
        assert run(key, job='mismatch', limit=5) == -3
        assert run(key, job='mismatch', until=deadline+1) == -3
        ok('changed deployment allowance/deadline cannot reset shared state')
        assert run(key, job='invalid', limit=7) == -1
        assert run(key, job='invalid', limit=0) == -1
        assert run(key, job='invalid', limit=1.5) == -1
        ok('unsafe numeric allowances fail closed')
        assert run(key, job='expired', until=int(time.time())-1) == -2
        assert run(key, job='future', until=int(time.time())+86410) == -2
        ok('Redis server clock rejects expiry and distant activation')
        assert r.ttl(key) == -1
        ok('no TTL reset: spent permits outlive fixture state and cleanup')
        # A lost admission response and an ambiguous publish both retain the
        # successful first reservation. Retrying cannot obtain another permit.
        assert run(key, job='ambiguous') == 1 and run(key, job='ambiguous') == 0
        ok('uncertain admission/publication remains spent')
        concurrent_key = 'preview:concurrent:qstash-smoke-budget:v1'
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: run(concurrent_key, job=str(i)), range(64)))
        assert results.count(1) == 6 and results.count(-5) == 58
        assert r.hget(concurrent_key,'spent') == b'6'
        ok('64 concurrent unique admissions never exceed six publications')
        duplicate_key = 'preview:duplicates:qstash-smoke-budget:v1'
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: run(duplicate_key), range(64)))
        assert results.count(1) == 1 and results.count(0) == 63
        ok('64 concurrent duplicate admissions permit exactly one publication')
        corrupt = 'preview:corrupt:qstash-smoke-budget:v1'
        r.hset(corrupt, mapping={'limit':6,'deadline':deadline,'spent':'bad'})
        assert run(corrupt) == -3
        r.hset(corrupt,'spent',-1); assert run(corrupt) == -3
        r.hset(corrupt,'spent',.5); assert run(corrupt) == -3
        ok('corrupt counters fail closed without reset')
        wrongtype = 'preview:wrongtype:qstash-smoke-budget:v1'
        r.set(wrongtype,'bad')
        try: run(wrongtype); raise AssertionError('Wrong-type state was accepted')
        except redis.ResponseError: pass
        ok('wrong-type budget is not replaced')
        assert all(r.dump(k)==v for k,v in before.items())
        ok('all synthetic Production and other-Preview values/TTLs remain untouched')
        print(json.dumps({'passed':len(checks), 'engine':r.info('server').get('valkey_version'), 'checks':checks}))
    finally:
        r.close(); process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
