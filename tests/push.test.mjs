// Unit tests for the 0.4.0 kronicle-lite retraction push / pulse that need no
// kronicle-lite: the Bash command analysis (scripts/pulse.jq), the retraction
// renderer (scripts/retractions.jq, incl. the cosmetic flag kronicle-lite may
// add), inertness without kronicle-lite, and the fail-open paths with a fake
// CLI that hangs or crashes. The contract with the REAL CLI is in
// kronicle-contract.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SCRIPTS, sandbox, hook } from './helpers.mjs';

const MATCH = 'deploy|migrate|publish|release|git push|terraform apply|kubectl apply';

function analyse(command, match = MATCH) {
  const r = spawnSync('jq', ['-c', '--arg', 'match', match, '-f', path.join(SCRIPTS, 'pulse.jq')], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('pulse.jq: plain world-changing commands match, with word boundaries', () => {
  for (const c of ['./bin/deploy --target prod-b', 'make deploy', 'npm publish', 'git push origin main', 'terraform apply -auto-approve', 'kubectl apply -f k8s/', 'rails db:migrate', 'gh release create v1', './scripts/deploy-prod.sh', 'FOO=1 sudo ./scripts/release.sh 2>&1 | tee log', 'cat deployment.yaml | kubectl apply -f -', 'echo $(./bin/deploy)']) {
    assert.ok(analyse(c).world.length === 1, `world-changing: ${c}`);
  }
  for (const c of ['cat deployment.yaml', 'grep -n deploy docs/runbook.md', 'git commit -m "prepare release"', './bin/predeploy-lint', 'ls deployments/', 'git log --grep=release', './bin/notify --channel "#ops"', './bin/build # then deploy', "echo 'deploy later'", 'git status && git log']) {
    assert.deepEqual(analyse(c).world, [], `not world-changing: ${c}`);
  }
});

test('pulse.jq: chains — a world-changing step after a non-inert step is risky; cd/export/read-only steps are not', () => {
  const f2 = analyse('./bin/preflight && ./bin/build && ./bin/migrate && ./bin/deploy --target x');
  assert.deepEqual(f2.world, ['./bin/migrate', './bin/deploy --target x']);
  assert.deepEqual(f2.risky, ['./bin/migrate', './bin/deploy --target x']);
  assert.equal(f2.head, './bin/migrate');
  assert.deepEqual(analyse('npm test && npm publish').risky, ['npm publish']);
  assert.deepEqual(analyse('./bin/build; ./bin/deploy').risky, ['./bin/deploy']);
  assert.deepEqual(analyse('./bin/build\n./bin/deploy').risky, ['./bin/deploy']);
  assert.deepEqual(analyse('./bin/build || ./bin/deploy').risky, ['./bin/deploy']);
  assert.deepEqual(analyse('sleep 5 & ./bin/deploy').risky, ['./bin/deploy']);
  assert.deepEqual(analyse('terraform apply && kubectl apply -f k').risky, ['kubectl apply -f k'], 'a world-changing step is itself a step');
  for (const c of ['cd /repo && ./bin/deploy', 'export A=1; ./bin/deploy', 'git status && git push', 'ls >&2 && ./bin/deploy', 'echo go && make deploy', './bin/deploy && ./bin/notify', 'cat x | kubectl apply -f -']) {
    assert.deepEqual(analyse(c).risky, [], `not risky: ${c}`);
  }
  assert.deepEqual(analyse('(cd x && make deploy)').world.length, 1, 'subshell groups are split through');
});

test('pulse.jq: quoting — separators and keywords inside quotes are text', () => {
  const r = analyse('./bin/deploy --target "a && b; c" --note \'release; now\'');
  assert.equal(r.world.length, 1);
  assert.deepEqual(r.risky, []);
  assert.deepEqual(analyse('git commit -m "deploy: x" && git status').world, []);
  assert.equal(analyse('bash -c "./bin/build; ./bin/deploy"').world.length, 1, 'opaque runners are matched on their whole text');
  assert.deepEqual(analyse('echo "a\\" && ./bin/deploy"').world, [], 'escaped quote stays inside the string');
});

test('pulse.jq: pulse_match is configurable (JSON-escaped backslashes are accepted)', () => {
  assert.equal(analyse('alembic upgrade head', 'alembic upgrade').world.length, 1);
  assert.deepEqual(analyse('./bin/deploy', 'alembic upgrade').world, []);
  assert.equal(analyse('./bin/ship-v2', 'ship-v\\\\d').world.length, 1);
});

function render(orient, showCosmetic = '0') {
  const r = spawnSync('jq', ['-r', '--arg', 'show_cosmetic', showCosmetic, '-f', path.join(SCRIPTS, 'retractions.jq')], { input: JSON.stringify(orient), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [cursor, seq, counts, ...lines] = r.stdout.replace(/\n$/, '').split('\n');
  const [shown, blocking, cosmetic] = counts.split(' ').map(Number);
  return { cursor, seq, shown, blocking, cosmetic, lines };
}
const R = (extra) => ({ seq: 7, event_type: 'block.superseded', kind: 'supersession', severity: 'behavioral', doc_slug: 'runbook', heading_path: ['Runbook', 'Deploy'], old_text: 'target: staging-a', new_text: 'target: staging-b', diff: 'target: [-staging-a-]{+staging-b+}', reason_line: 'x', ...extra });

test('retractions.jq: what you relied on, what it says now, the diff; removal; bare events', () => {
  const o = render({ cursor: 'sxt1.abc', head: { seq: 9 }, retractions: [R(), R({ seq: 8, kind: 'tombstone', severity: 'safety', new_text: null, diff: null }), R({ seq: 9, old_text: null, new_text: null, diff: null, reason_line: 'You previously relied on block b1; it is gone.' })] });
  assert.equal(o.cursor, 'sxt1.abc');
  assert.equal(o.seq, '9');
  assert.equal(o.shown, 3);
  assert.equal(o.blocking, 3);
  assert.match(o.lines[0], /^- runbook › Runbook › Deploy \(seq 7, supersession\/behavioral\): relied on "target: staging-a" → now "target: staging-b"; diff: target: \[-staging-a-\]\{\+staging-b\+\}$/);
  assert.match(o.lines[1], /now REMOVED$/);
  assert.match(o.lines[2], /You previously relied on block b1/);
});

test('retractions.jq: cosmetic flag (kronicle-lite next) — hidden by default, never blocking; absent flag = semantic', () => {
  const rs = [R(), R({ seq: 8, cosmetic: true }), R({ seq: 9, change_class: 'cosmetic' }), R({ seq: 10, semantic: false }), R({ seq: 11, change_class: 'semantic' }), R({ seq: 12, severity: 'informational' })];
  const o = render({ cursor: 'c', head: { seq: 12 }, retractions: rs });
  assert.equal(o.cosmetic, 3);
  assert.equal(o.shown, 3, 'semantic ones only');
  assert.equal(o.blocking, 2, 'informational never blocks');
  assert.ok(o.lines.every((l) => !/cosmetic/.test(l)));
  const all = render({ cursor: 'c', head: { seq: 12 }, retractions: rs }, '1');
  assert.equal(all.shown, 6);
  assert.equal(all.blocking, 2, 'shown cosmetic ones still never block');
  assert.equal(all.lines.filter((l) => /, cosmetic\)/.test(l)).length, 3);
});

test('retractions.jq: long lists and long text are bounded', () => {
  const big = 'x'.repeat(5000);
  const o = render({ cursor: 'c', head: { seq: 99 }, retractions: Array.from({ length: 20 }, (_, i) => R({ seq: i, old_text: big, new_text: big, diff: big })) });
  assert.equal(o.lines.length, 7);
  assert.match(o.lines[6], /and 14 more/);
  assert.ok(o.lines.every((l) => l.length < 700), 'each line is clipped');
});

// ── hook behaviour without the real CLI ──────────────────────────────────
const pre = (sb, command, extra = {}, sid = 'sess-unit-1') => hook('pulse.sh', { session_id: sid, cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, sb.env, extra);
const post = (sb, extra = {}, sid = 'sess-unit-1') => hook('post-tool-use.sh', { session_id: sid, cwd: sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: {} }, sb.env, extra);

test('push/pulse are inert when kronicle-lite is not configured: no output, no CLI lookup, an .off latch', () => {
  const sb = sandbox();
  try {
    assert.equal(post(sb).stdout, '');
    assert.equal(pre(sb, './bin/build && ./bin/deploy').stdout, '', 'not even the chain split without kronicle-lite');
    assert.ok(fs.existsSync(path.join(sb.run, 'push', 'sessunit.off')));
    assert.ok(!fs.existsSync(path.join(sb.run, 'log')) || !/push|pulse/.test(fs.readFileSync(path.join(sb.run, 'log'), 'utf8')));
  } finally { sb.cleanup(); }
});

test('push/pulse: configured but no CLI → off, logged once, allow', () => {
  const sb = sandbox();
  try {
    const env = { CC_ANCHOR_KRONICLE: '1', PATH: '/usr/bin:/bin', CC_ANCHOR_KRONICLE_LITE_BIN: '' };
    assert.equal(pre(sb, './bin/deploy', env).stdout, '');
    assert.equal(post(sb, env).stdout, '');
    const log = fs.readFileSync(path.join(sb.run, 'log'), 'utf8');
    assert.equal(log.match(/CLI was not found/g)?.length, 1);
  } finally { sb.cleanup(); }
});

test('push/pulse fail open: a hanging CLI is killed at push_timeout, the command is allowed, back-off holds, one log line', () => {
  const sb = sandbox();
  try {
    const fake = path.join(sb.base, 'kronicle-lite');
    fs.writeFileSync(fake, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });
    const env = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: fake, CC_ANCHOR_PUSH_TIMEOUT: '1' };
    let t0 = Date.now();
    const r = pre(sb, './bin/deploy --target x', env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'allowed (no decision)');
    assert.ok(Date.now() - t0 < 6000, `bounded: ${Date.now() - t0} ms`);
    t0 = Date.now();
    assert.equal(post(sb, env).stdout, '');
    assert.ok(Date.now() - t0 < 1500, 'inside the 60 s back-off the CLI is not called again');
    const log = fs.readFileSync(path.join(sb.run, 'log'), 'utf8');
    assert.equal(log.match(/timed out/g)?.length, 1);
  } finally { sb.cleanup(); }
});

test('push/pulse fail open: a CLI that crashes or prints garbage → allow, nothing on stdout', () => {
  const sb = sandbox();
  try {
    for (const body of ['echo boom >&2; exit 3', 'echo "not json"; exit 0']) {
      const fake = path.join(sb.base, 'kronicle-lite');
      fs.writeFileSync(fake, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      fs.rmSync(path.join(sb.run, 'push'), { recursive: true, force: true });
      const env = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: fake };
      for (const r of [post(sb, env), pre(sb, './bin/deploy', env), pre(sb, './bin/build && ./bin/deploy', env)]) {
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '', `${body}: ${r.stdout}`);
      }
    }
  } finally { sb.cleanup(); }
});

test('push=0 / pulse=0 switch the hooks off even when kronicle-lite is configured', () => {
  const sb = sandbox();
  try {
    const fake = path.join(sb.base, 'kronicle-lite');
    fs.writeFileSync(fake, `#!/usr/bin/env bash\necho called >> ${JSON.stringify(path.join(sb.base, 'calls'))}\nexit 1\n`, { mode: 0o755 });
    const env = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: fake };
    assert.equal(pre(sb, './bin/deploy', { ...env, CC_ANCHOR_PULSE: '0' }).stdout, '');
    assert.equal(post(sb, { ...env, CC_ANCHOR_PUSH: '0' }).stdout, '');
    assert.ok(!fs.existsSync(path.join(sb.base, 'calls')), 'the CLI was never run');
  } finally { sb.cleanup(); }
});

test('hooks.json registers the pulse on Bash and keeps the scope guard on edits', () => {
  const j = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'hooks', 'hooks.json'), 'utf8'));
  const pre = j.hooks.PreToolUse;
  assert.ok(pre.some((e) => e.matcher === 'Bash' && e.hooks.some((h) => /pulse\.sh/.test(h.args.join(' ')))));
  assert.ok(pre.some((e) => /Edit/.test(e.matcher) && e.hooks.some((h) => /pre-tool-use\.sh/.test(h.args.join(' ')))));
  for (const e of [...j.hooks.PostToolUse, ...pre]) for (const h of e.hooks) assert.ok(h.timeout >= 10, 'room for two bounded orient calls');
});

test('the kronicle-lite CLI is found in the npx cache (plugin-only installs launch the server with npx)', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.home, '.npm', '_npx', '0a1b2c', 'node_modules', 'kronicle-lite', 'dist');
    fs.mkdirSync(dir, { recursive: true });
    const calls = path.join(sb.base, 'calls');
    fs.writeFileSync(path.join(dir, 'cli.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); process.exit(1);\n`);
    fs.writeFileSync(path.join(dir, '..', 'package.json'), '{"name":"kronicle-lite","version":"0.6.0"}');
    // npm test puts node_modules/.bin (with a real kronicle-lite) on PATH; keep it out.
    const PATH = process.env.PATH.split(':').filter((d) => !d.includes('node_modules')).join(':');
    post(sb, { CC_ANCHOR_KRONICLE: '1', PATH });
    assert.match(fs.readFileSync(calls, 'utf8'), /^orient --json --actor cc-anchor-sessunit/m);
    assert.match(fs.readFileSync(path.join(sb.run, 'push', 'sessunit.cfg'), 'utf8'), /_npx\/0a1b2c\/node_modules\/kronicle-lite\/dist\/cli\.js/);
  } finally { sb.cleanup(); }
});
