// 0.5.1: the hardening-round-2 harness for the pending gate (tests/stress/gate.sh,
// from agent-memory-bench stress/cca/gate.sh: 29 checks, 17 failed on 0.5.0) plus the
// 0.5.1 semantics, end to end against the real kronicle-lite >= 0.8.0 CLI. Temp HOME
// and project dirs only. The static corpora (tests/stress/pulse-corpus*.sh) run in
// push.test.mjs. Skipped without a kronicle-lite that has `pending`, unless
// CC_ANCHOR_REQUIRE_PENDING=1 (CI), which makes that a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from './helpers.mjs';

const CANDIDATES = [process.env.KRONICLE_LITE_PENDING_CLI, process.env.KRONICLE_LITE_CLI, path.join(ROOT, 'node_modules', 'kronicle-lite', 'dist', 'cli.js')];
const hasPending = (cli) => spawnSync('node', [cli, 'pending', '--actor', 'probe', '--json', '--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'klcap-'))], { encoding: 'utf8' }).status === 0;
const KL = CANDIDATES.find((f) => f && fs.existsSync(f) && hasPending(f));
const REQUIRED = process.env.CC_ANCHOR_REQUIRE_PENDING === '1';

test('stress/gate.sh: every check passes (round-2 findings H2-01…H2-09 + 0.5.1 semantics)', { skip: !KL && !REQUIRED && 'no kronicle-lite with `pending` (>= 0.8.0)', timeout: 900000 }, () => {
  assert.ok(KL, 'CC_ANCHOR_REQUIRE_PENDING=1 but no kronicle-lite with `pending` was found');
  // A physical temp root: the ~/.claude.json-by-physical-path case must not depend on
  // /var -> /private/var (macOS).
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cca-gate-'));
  try {
    const r = spawnSync('bash', [path.join(ROOT, 'tests', 'stress', 'gate.sh')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: tmp, TMPROOT: tmp, CCA: ROOT, KLBIN: KL, TZ: 'UTC', CC_ANCHOR_SYNC: '1' },
    });
    const fails = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
    assert.deepEqual(fails, [], r.stdout.slice(-3000) + r.stderr.slice(-2000));
    assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
    const m = r.stdout.match(/gate: pass=(\d+) fail=0/);
    assert.ok(m && Number(m[1]) >= 60, r.stdout.slice(-500));
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// 0.5.1: the sea-lite claim guards (Edit/Write scope guard, Bash claimed-path guard) against
// the real sea-lite CLI: round-1 bash-guard.sh (18 cases) and round-2 bash-guard2.sh /
// scope-guard.sh (H2-18 … H2-24). Skipped without a sea-lite CLI.
const SL = [process.env.SEA_LITE_CLI, path.join(ROOT, 'node_modules', 'sea-lite', 'dist', 'cli.js')].find((f) => f && fs.existsSync(f));
for (const f of ['bash-guard.sh', 'bash-guard2.sh', 'scope-guard.sh']) {
  // GNU touch -d / date +%N in the harnesses: Linux only (macOS is covered by the unit tests).
  const skip = (!SL && 'no sea-lite CLI (npm i --no-save sea-lite@^0.4.0)') || (process.platform !== 'linux' && 'GNU coreutils harness (Linux only)');
  test(`stress/${f}: every case passes`, { skip, timeout: 900000 }, () => {
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cca-sg-'));
    try {
      const r = spawnSync('bash', [path.join(ROOT, 'tests', 'stress', f)], {
        encoding: 'utf8',
        // no CC_ANCHOR_SYNC: the harness hangs sea-lite on purpose, and an inline heartbeat would wait for it
        env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, TMPROOT: tmp, CCA: ROOT, SLBIN: SL, TZ: 'UTC', CC_ANCHOR_PERF_TESTS: process.env.CC_ANCHOR_PERF_TESTS ?? '0' },
      });
      const fails = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
      assert.deepEqual(fails, [], r.stdout.slice(-3000) + r.stderr.slice(-2000));
      assert.match(r.stdout, /pass=\d+ fail=0/, r.stdout.slice(-1500));
    } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
}
