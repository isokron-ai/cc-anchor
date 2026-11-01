// Contract tests for the 0.4.0 retraction push / pulse against the REAL
// kronicle-lite CLI (>= 0.5.0; CI installs the published 0.6.0), the same way
// sea-contract.test.mjs pins the scope guard to the real sea-lite.
//
// The CLI is found at $KRONICLE_LITE_CLI, ./node_modules/kronicle-lite, or a
// sibling checkout ../kronicle-lite/dist/cli.js (built). If none is present
// the tests FAIL with instructions; CC_ANCHOR_SKIP_KRONICLE_CONTRACT=1 skips.
//
// Each test drives the hook scripts exactly as Claude Code does (JSON on
// stdin, env) while the "world" changes through `kronicle-lite put` — the
// same write path the agent's MCP server uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, sandbox, hook } from './helpers.mjs';

const CANDIDATES = [process.env.KRONICLE_LITE_CLI, path.join(ROOT, 'node_modules', 'kronicle-lite', 'dist', 'cli.js'), path.resolve(ROOT, '..', 'kronicle-lite', 'dist', 'cli.js')];
const KL = CANDIDATES.find((f) => f && fs.existsSync(f));
const SKIP = process.env.CC_ANCHOR_SKIP_KRONICLE_CONTRACT === '1' ? 'CC_ANCHOR_SKIP_KRONICLE_CONTRACT=1' : false;
const opts = { skip: SKIP || (!KL && 'kronicle-lite CLI not found (see the first test)') };
// kronicle-lite >= 0.8.0 reports per-actor `pending` (version-bound reconciliation);
// the pulse then gates on it instead of "retraction since the last look".
const CAP = !!KL && spawnSync('node', [KL, 'pending', '--actor', 'probe', '--json', '--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'klcap-'))], { encoding: 'utf8' }).status === 0;

test('the real kronicle-lite CLI (>= 0.5.0) is available for the contract tests', { skip: SKIP }, () => {
  assert.ok(KL, `kronicle-lite CLI not found; tried ${CANDIDATES.filter(Boolean).join(', ')}. Run \`npm i --no-save kronicle-lite@0.6.0\`, set KRONICLE_LITE_CLI, or CC_ANCHOR_SKIP_KRONICLE_CONTRACT=1 to skip.`);
  const r = spawnSync('node', [KL, '--version'], { encoding: 'utf8' });
  assert.match(r.stdout.trim(), /^(0\.([5-9]|\d{2,})|[1-9])\./, `kronicle-lite ${r.stdout.trim()} is older than 0.5.0 (no retraction diff)`);
});

const RB = (target, reviewed = '2026-10-01') => `# Runbook\n\n## Deploy\n\nDeploy with ./bin/deploy --target ${target}.\n\nLast reviewed: ${reviewed}\n`;

/** A project + kronicle-lite store holding a runbook; helpers to drive the hooks. */
function world({ sid = 'sess-kl-0001', env: extraEnv = {}, mcpJson = false } = {}) {
  const sb = sandbox();
  const data = path.join(sb.base, 'kl-data');
  const put = (content, slug = 'runbook') => {
    const f = path.join(sb.base, `${slug}-${Date.now()}-${Math.random()}.md`);
    fs.writeFileSync(f, content);
    const r = spawnSync('node', [KL, 'put', slug, f, '--data-dir', data], { encoding: 'utf8', cwd: sb.proj });
    assert.equal(r.status, 0, r.stderr);
  };
  put(RB('staging-a'));
  // The agent reads the runbook through its MCP server (actor "local-agent", the
  // server default): with kronicle-lite >= 0.8.0 that is what makes a later
  // change pending for it. Older versions have no `get`; ignored there.
  const read = (actor = 'local-agent', slug = 'runbook') => spawnSync('node', [KL, 'get', slug, '--actor', actor, '--data-dir', data], { encoding: 'utf8', cwd: sb.proj });
  if (CAP) read();
  // Generous CLI timeout: a loaded runner can take seconds to start node +
  // sqlite; the timeout path itself is covered in push.test.mjs.
  const base = { CC_ANCHOR_KRONICLE_LITE_BIN: KL, CC_ANCHOR_PUSH_TIMEOUT: '30', ...extraEnv };
  if (mcpJson) {
    fs.writeFileSync(path.join(sb.proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'kronicle-lite': { command: 'npx', args: ['-y', 'kronicle-lite@0.6.0', 'serve', '--data-dir', data] } } }));
  } else {
    Object.assign(base, { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_DATA_DIR: data });
  }
  const start = (s = sid, source = 'startup') => hook('session-start.sh', { session_id: s, cwd: sb.proj, hook_event_name: 'SessionStart', source }, sb.env, base);
  const post = (command = 'make', s = sid, extra = {}, agent = null) => hook('post-tool-use.sh', { session_id: s, cwd: sb.proj, hook_event_name: 'PostToolUse', ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}), tool_name: 'Bash', tool_input: { command }, tool_response: {} }, sb.env, { ...base, ...extra });
  const spawn = (agent, s = sid) => hook('subagent-start.sh', { session_id: s, cwd: sb.proj, hook_event_name: 'SubagentStart', agent_id: agent, agent_type: 'general-purpose' }, sb.env, base);
  const stopAgent = (agent, s = sid) => hook('subagent-stop.sh', { session_id: s, cwd: sb.proj, hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: agent, agent_type: 'general-purpose', last_assistant_message: 'done' }, sb.env, base);
  const pre = (command, s = sid, extra = {}, agent = null) => hook('pulse.sh', { session_id: s, cwd: sb.proj, hook_event_name: 'PreToolUse', ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}), tool_name: 'Bash', tool_input: { command } }, sb.env, { ...base, ...extra });
  const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext ?? null;
  const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
  const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const log = () => (fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : '');
  return { sb, data, put, read, start, post, pre, spawn, stopAgent, ctx, decision, reason, log };
}

test('push (real CLI): a retraction that lands during a tool call is injected after it — relied on / now / diff — exactly once', opts, () => {
  const w = world();
  try {
    assert.equal(w.start().stdout, '', 'SessionStart initialises the cursor silently (no card yet)');
    assert.ok(fs.existsSync(path.join(w.sb.run, 'push', 'sesskl00.cursor')));
    assert.equal(w.post('./bin/preflight').stdout, '', 'nothing changed: nothing injected');
    w.put(RB('staging-b', '2026-10-31'));
    const r = w.post('./bin/build');
    assert.equal(r.status, 0);
    assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'PostToolUse');
    const c = w.ctx(r);
    assert.match(c, /kronicle-lite changed while you were working — 2 retraction\(s\)/);
    assert.match(c, /runbook › Runbook › Deploy \(seq \d+, supersession\/behavioral\): relied on "Deploy with \.\/bin\/deploy --target staging-a\." → now "Deploy with \.\/bin\/deploy --target staging-b\."; diff: .*\[-staging-a\.-\]\{\+staging-b\.\+\}/);
    assert.match(c, /Re-read the affected document/);
    assert.equal(w.ctx(w.post('cat docs/runbook.md')), null, 'delivered once: the cursor advanced and persisted');
    assert.equal(w.ctx(w.post('ls')), null);
    assert.equal(w.log().match(/^.* push: 2 retraction\(s\)/gm)?.length, 1, 'one log line per push');
  } finally { w.sb.cleanup(); }
});

for (const [label, env] of [['', {}], [' — 1-second mtime view (bash 3.2 / macOS)', { CC_ANCHOR_TEST_MTIME_SECONDS: '1' }]]) test(`push (real CLI): the hot path does not spawn kronicle-lite while the store is unchanged${label}`, opts, () => {
  const w = world({ env });
  try {
    w.start();
    w.post('a'); // settles the gate after init
    const shim = path.join(w.sb.base, 'kl-shim');
    const calls = path.join(w.sb.base, 'calls');
    fs.writeFileSync(shim, `#!/usr/bin/env bash\necho x >> ${JSON.stringify(calls)}\nexec node ${JSON.stringify(KL)} "$@"\n`, { mode: 0o755 });
    // The session's resolved CLI path is cached in <sid8>.cfg; point it at the shim.
    const cfg = path.join(w.sb.run, 'push', 'sesskl00.cfg');
    const [dd] = fs.readFileSync(cfg, 'utf8').split('\n');
    fs.writeFileSync(cfg, `${dd}\n${shim}\n`);
    for (let i = 0; i < 5; i++) assert.equal(w.post(`step ${i}`).stdout, '');
    assert.ok(!fs.existsSync(calls), 'no orient call on an unchanged store');
    w.put(RB('staging-c'));
    assert.match(w.ctx(w.post('build')) || '', /staging-c/);
    const n = fs.readFileSync(calls, 'utf8').trim().split('\n').length;
    assert.equal(n, 2, 'a change costs a pulse (head) + one retractions call');
    w.post('next'); // settle: one read-only pulse after our own orient write
    w.post('next2');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 3, 'then quiet again');
  } finally { w.sb.cleanup(); }
});

test('pulse (real CLI): a world-changing command issued straight after the push is denied with the diff; after any other tool call it runs', opts, () => {
  const w = world();
  try {
    w.start();
    w.put(RB('staging-b'));
    assert.ok(w.ctx(w.post('./bin/build')));
    const d = w.pre('./bin/deploy --target staging-a');
    assert.equal(w.decision(d), 'deny');
    assert.match(w.reason(d), /did NOT run `\.\/bin\/deploy --target staging-a`/);
    assert.match(w.reason(d), /\[-staging-a\.-\]\{\+staging-b\.\+\}/);
    assert.match(w.reason(d), /Re-read/);
    if (CAP) {
      assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny', 'pending: being told is not reconciling');
      w.read();
      assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 'pending: re-reading the current version clears it');
    } else {
      assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 'the deny delivered it: re-running is allowed');
    }
    // the read-in-between path
    w.put(RB('staging-c'));
    assert.ok(w.ctx(w.post('./bin/migrate-check')));
    w.post('cat runbook.md');
    if (CAP) {
      assert.equal(w.decision(w.pre('./bin/deploy --target staging-c')), 'deny', 'pending: a tool call is not a re-read');
      w.read();
    }
    assert.equal(w.pre('./bin/deploy --target staging-c').stdout, '', 'a tool call in between (legacy) / a re-read (pending) = allowed');
    assert.equal(w.pre('./bin/notify --channel ops').stdout, '', 'non-world-changing commands are never checked');
  } finally { w.sb.cleanup(); }
});

test('pulse (real CLI): a change that lands after the last tool call is caught before the deploy (push could not deliver it)', opts, () => {
  const w = world();
  try {
    w.start();
    w.post('./bin/build');
    w.put(RB('prod-b'));
    const d = w.pre('./bin/deploy --target staging-a');
    assert.equal(w.decision(d), 'deny');
    assert.match(w.reason(d), /staging-a\.-\]\{\+prod-b/);
    assert.equal(w.ctx(w.post('cat runbook')), null, 'the deny advanced the cursor: no duplicate push');
    if (CAP) { assert.equal(w.decision(w.pre('./bin/deploy --target prod-b')), 'deny'); w.read(); }
    assert.equal(w.pre('./bin/deploy --target prod-b').stdout, '');
  } finally { w.sb.cleanup(); }
});

test('pulse (real CLI): chained `a && b && deploy` is split; pulse_chain=check allows it; inert prefixes are fine', opts, () => {
  const w = world();
  try {
    w.start();
    const d = w.pre('./bin/preflight && ./bin/build && ./bin/migrate && ./bin/deploy --target staging-a');
    assert.equal(w.decision(d), 'deny');
    assert.match(w.reason(d), /each of `\.\/bin\/migrate`, `\.\/bin\/deploy --target staging-a` as its own Bash call/);
    assert.equal(w.pre('./bin/preflight && ./bin/build').stdout, '', 'the non-world-changing prefix runs');
    assert.equal(w.pre('cd /repo && ./bin/deploy --target staging-a').stdout, '');
    assert.equal(w.pre('./bin/build && ./bin/deploy', undefined, { CC_ANCHOR_PULSE_CHAIN: 'check' }).stdout, '');
  } finally { w.sb.cleanup(); }
});

test('pulse (real CLI): pulse_mode=warn allows the command and carries the diff as context', opts, () => {
  const w = world({ env: { CC_ANCHOR_PULSE_MODE: 'warn' } });
  try {
    w.start();
    w.post('x');
    w.put(RB('staging-z'));
    const r = w.pre('git push origin main');
    assert.equal(w.decision(r), null);
    assert.match(w.ctx(r), /pulse \(warn\): `git push origin main` is about to run/);
    assert.match(w.ctx(r), /staging-z/);
  } finally { w.sb.cleanup(); }
});

test('push/pulse (real CLI): sessions keep separate cursors; a tombstone is a safety retraction', opts, () => {
  const w = world();
  try {
    w.start('sess-A-000001');
    w.start('sess-B-000002');
    w.put(RB('staging-b'));
    assert.match(w.ctx(w.post('x', 'sess-A-000001')) || '', /staging-b/);
    assert.match(w.ctx(w.post('x', 'sess-B-000002')) || '', /staging-b/, 'B is told too: delivery is per session');
    assert.equal(w.ctx(w.post('y', 'sess-A-000001')), null);
    w.put('# Runbook\n\n## Deploy\n\nDeploy with ./bin/deploy --target staging-b.\n');
    const c = w.ctx(w.post('z', 'sess-A-000001')) || '';
    assert.match(c, /tombstone\/safety\): relied on "Last reviewed: 2026-10-01" → now REMOVED/);
  } finally { w.sb.cleanup(); }
});

test('push (real CLI): auto-detects kronicle-lite and its --data-dir from .mcp.json (no CC_ANCHOR_* env)', opts, () => {
  const w = world({ mcpJson: true });
  try {
    w.start();
    w.put(RB('staging-q'));
    assert.match(w.ctx(w.post('build')) || '', /staging-q/);
    const [dd] = fs.readFileSync(path.join(w.sb.run, 'push', 'sesskl00.cfg'), 'utf8').split('\n');
    assert.equal(dd, w.data);
  } finally { w.sb.cleanup(); }
});

test('push (real CLI): without a SessionStart the first tool call starts the cursor (silently) and later changes are pushed', opts, () => {
  const w = world();
  try {
    assert.equal(w.post('first').stdout, '');
    w.put(RB('staging-l'));
    assert.match(w.ctx(w.post('second')) || '', /staging-l/);
  } finally { w.sb.cleanup(); }
});

test('push (real CLI): a cursor survives compaction and resume (SessionStart does not reset it)', opts, () => {
  const w = world();
  try {
    w.start();
    w.put(RB('staging-r'));
    w.start(undefined, 'compact');
    assert.match(w.ctx(w.post('after-compact')) || '', /staging-r/, 'the change made before the compaction is still delivered');
  } finally { w.sb.cleanup(); }
});

// ── 0.5.0: per-subagent cursors ──────────────────────────────────────────
test('per-subagent cursors (real CLI): one retraction, parent + two subagents → each gets it exactly once', opts, () => {
  const w = world();
  try {
    w.start();
    w.post('./bin/preflight');
    assert.equal(w.spawn('agent-a1').stdout, '', 'SubagentStart is silent');
    assert.equal(w.spawn('agent-b2').stdout, '');
    w.put(RB('staging-b'));
    const got = { parent: 0, a: 0, b: 0 };
    const count = (r, k) => { if (/staging-b/.test(w.ctx(r) || '')) got[k]++; };
    // Interleaved, several tool calls each: A consumes first, then B, then the parent.
    for (let i = 0; i < 3; i++) count(w.post(`a${i}`, undefined, {}, 'agent-a1'), 'a');
    for (let i = 0; i < 3; i++) count(w.post(`b${i}`, undefined, {}, 'agent-b2'), 'b');
    for (let i = 0; i < 3; i++) count(w.post(`p${i}`), 'parent');
    assert.deepEqual(got, { parent: 1, a: 1, b: 1 });
  } finally { w.sb.cleanup(); }
});

test('per-subagent cursors (real CLI): a change the parent has not consumed yet reaches a subagent spawned after it; a stopped subagent’s cursor is dropped', opts, () => {
  const w = world();
  try {
    w.start();
    w.put(RB('staging-c')); // lands before the spawn; the parent has not seen it
    w.spawn('agent-c3');
    assert.match(w.ctx(w.post('c', undefined, {}, 'agent-c3')) || '', /staging-c/);
    assert.match(w.ctx(w.post('p')) || '', /staging-c/, 'the parent still gets it');
    const f = path.join(w.sb.run, 'push', 'sesskl00.a-agent-c3.cursor');
    assert.ok(fs.existsSync(f));
    w.stopAgent('agent-c3');
    assert.ok(!fs.existsSync(f), 'SubagentStop drops the subagent cursor');
  } finally { w.sb.cleanup(); }
});

test('per-subagent cursors (real CLI): without a SubagentStart the subagent seeds from the parent lazily; the pulse is per agent', opts, () => {
  const w = world();
  try {
    w.start();
    w.post('p0');
    w.put(RB('staging-d'));
    assert.match(w.ctx(w.post('x', undefined, {}, 'agent-d4')) || '', /staging-d/, 'no SubagentStart: seeded from the parent at the first tool call');
    const d = w.pre('./bin/deploy --target staging-a', undefined, {}, 'agent-d4');
    assert.equal(w.decision(d), 'deny', 'pending is per agent: d4 went straight to deploy');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-a')), 'deny', 'the parent has not seen it either: its own pulse denies');
  } finally { w.sb.cleanup(); }
});

test('pulse (real CLI): a world-changing interpreter one-liner is denied ONCE; the identical retry runs', opts, () => {
  const w = world();
  try {
    w.start();
    const cmd = "python3 -c \"import os; os.system('git push origin main')\"";
    const d = w.pre(cmd);
    assert.equal(w.decision(d), 'deny');
    assert.match(w.reason(d), /inside an interpreter one-liner/);
    assert.match(w.reason(d), /run this exact call again/);
    assert.equal(w.pre(cmd).stdout, '', 'retry allowed');
    assert.equal(w.decision(w.pre("node -e \"require('child_process').execSync('npm publish')\"")), 'deny', 'a different one-liner is denied once too');
  } finally { w.sb.cleanup(); }
});

test('push/pulse (real CLI): an exact mtime tie (1-s filesystem, one kernel tick) — the push re-reads once per second at most, the pulse always', opts, () => {
  const w = world();
  try {
    w.start();
    w.post('a');
    const shim = path.join(w.sb.base, 'kl-shim');
    const calls = path.join(w.sb.base, 'calls');
    fs.writeFileSync(shim, `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(calls)}\nexec node ${JSON.stringify(KL)} "$@"\n`, { mode: 0o755 });
    const cfg = path.join(w.sb.run, 'push', 'sesskl00.cfg');
    const [dd] = fs.readFileSync(cfg, 'utf8').split('\n');
    fs.writeFileSync(cfg, `${dd}\n${shim}\n`);
    const n = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0);
    const stamp = path.join(w.sb.run, 'push', 'sesskl00.stamp');
    const db = path.join(w.data, 'kronicle-lite.db');
    // The clock is driven explicitly (CC_ANCHOR_TEST_NOW), so no assertion
    // depends on where a real second boundary falls.
    const NOW = Math.floor(Date.now() / 1000); // pinned: the hooks see this second throughout
    const tie = (stampSecond) => {
      const t = NOW - 5;
      fs.writeFileSync(stamp, `${stampSecond}\n`);
      fs.utimesSync(db, t, t); fs.utimesSync(stamp, t, t); // identical at every precision
    };
    const at = { CC_ANCHOR_TEST_NOW: String(NOW) };
    tie(NOW);
    w.post('same second as our read', undefined, at);
    assert.equal(n(), 0, 'push: tie, clock still inside the stamp\'s second → no spawn');
    w.pre('./bin/deploy --target staging-a', undefined, at);
    assert.equal(n(), 1, 'pulse: a tie always re-reads (one read-only pulse)');
    tie(NOW - 3);
    w.post('a later second', undefined, at);
    assert.equal(n(), 2, 'push: tie from an earlier second → one re-read…');
    w.post('again', undefined, at);
    assert.equal(n(), 2, '…which stamps a newer mtime than the store: settled');
  } finally { w.sb.cleanup(); }
});

test('per-subagent cursors (real CLI): ids that share a long prefix, or are long / not filename-safe, never share a cursor', opts, () => {
  const w = world();
  try {
    w.start(); w.post('p0');
    const ids = ['agent-0123456789abcdefX', 'agent-0123456789abcdefY', `agent:${'z'.repeat(80)}/1`, `agent:${'z'.repeat(80)}/2`];
    for (const id of ids) w.spawn(id);
    w.put(RB('staging-k'));
    for (const id of ids) {
      assert.match(w.ctx(w.post('a', undefined, {}, id)) || '', /staging-k/, `${id.slice(0, 30)}… gets it`);
      assert.equal(w.ctx(w.post('b', undefined, {}, id)), null, 'exactly once');
    }
    const files = fs.readdirSync(path.join(w.sb.run, 'push')).filter((f) => /\.a-.*\.cursor$/.test(f));
    assert.equal(files.length, 4, files.join(', '));
    assert.ok(files.includes('sesskl00.a-agent-0123456789abcdefX.cursor'), 'a filename-safe id is kept whole');
  } finally { w.sb.cleanup(); }
});

test('push (real CLI): a project reached through a symlink (macOS /var → /private/var) still gets its retractions (physical --cwd)', opts, () => {
  const w = world();
  try {
    const link = path.join(w.sb.base, 'proj-link');
    fs.symlinkSync(w.sb.proj, link);
    const env = { ...w.sb.env, CLAUDE_PROJECT_DIR: link };
    const base = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: KL, CC_ANCHOR_KRONICLE_DATA_DIR: w.data, CC_ANCHOR_PUSH_TIMEOUT: '30' };
    hook('session-start.sh', { session_id: 'sess-link-01', cwd: link, hook_event_name: 'SessionStart', source: 'startup' }, env, base);
    w.put(RB('staging-l')); // the CLI's process.cwd() is the physical path, like the MCP server's
    const r = hook('post-tool-use.sh', { session_id: 'sess-link-01', cwd: link, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'build' }, tool_response: {} }, env, base);
    assert.match(w.ctx(r) || '', /staging-l/);
  } finally { w.sb.cleanup(); }
});
