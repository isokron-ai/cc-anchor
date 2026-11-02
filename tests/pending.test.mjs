// 0.5.0: version-bound reconciliation with kronicle-lite >= 0.8.0 (`pending`).
// Delivered is not reconciled: the pulse denies world-changing commands while
// the agent's actor has pending changes, a re-read of the current version
// clears it with no manual step, the push reminds once if a change stays
// pending, and each subagent that names its own actor is gated on its own
// reads. Runs against a kronicle-lite CLI that has `pending` (>= 0.8.0: CI
// installs the published 0.8.0; or $KRONICLE_LITE_PENDING_CLI); skipped with a
// reason otherwise — the legacy path is covered by kronicle-contract (CI's
// 0.7.0 matrix leg). CC_ANCHOR_REQUIRE_PENDING=1 turns that skip into a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, sandbox, hook } from './helpers.mjs';

const CANDIDATES = [process.env.KRONICLE_LITE_PENDING_CLI, process.env.KRONICLE_LITE_CLI, path.join(ROOT, 'node_modules', 'kronicle-lite', 'dist', 'cli.js'), path.resolve(ROOT, '..', 'kl-lineage', 'dist', 'cli.js'), path.resolve(ROOT, '..', 'kronicle-lite', 'dist', 'cli.js')];
const hasPending = (cli) => spawnSync('node', [cli, 'pending', '--actor', 'probe', '--json', '--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'klcap-'))], { encoding: 'utf8' }).status === 0;
const KL = CANDIDATES.find((f) => f && fs.existsSync(f) && hasPending(f));
const opts = { skip: !KL && 'no kronicle-lite with `pending` (>= 0.8.0) found; set KRONICLE_LITE_PENDING_CLI' };

if (process.env.CC_ANCHOR_REQUIRE_PENDING === '1') {
  test('a kronicle-lite with `pending` (>= 0.8.0) is available (CC_ANCHOR_REQUIRE_PENDING=1)', () => {
    assert.ok(KL, `no kronicle-lite with \`pending\` found; tried ${CANDIDATES.filter(Boolean).join(', ')}. Run \`npm i --no-save kronicle-lite@0.8.0\` or set KRONICLE_LITE_PENDING_CLI.`);
  });
}

const RB = (target) => `# Runbook\n\n## Deploy\n\nDeploy with ./bin/deploy --target ${target}.\n`;
const SID = 'sess-pend-0001';

function world(extraEnv = {}) {
  const sb = sandbox();
  const data = path.join(sb.base, 'kl');
  const kl = (...a) => spawnSync('node', [KL, ...a, '--data-dir', data], { encoding: 'utf8', cwd: sb.proj });
  const put = (content) => { const f = path.join(sb.base, `rb-${Math.random()}.md`); fs.writeFileSync(f, content); assert.equal(kl('put', 'runbook', f).status, 0); };
  const read = (actor = 'local-agent') => assert.equal(kl('get', 'runbook', '--actor', actor).status, 0);
  put(RB('staging-a'));
  read();
  const base = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: KL, CC_ANCHOR_KRONICLE_DATA_DIR: data, CC_ANCHOR_PUSH_TIMEOUT: '30', ...extraEnv };
  const ag = (agent) => (agent ? { agent_id: agent, agent_type: 'general-purpose' } : {});
  const start = () => hook('session-start.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'SessionStart', source: 'startup' }, sb.env, base);
  const post = (command = 'make', agent = null, extra = {}) => hook('post-tool-use.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'PostToolUse', ...ag(agent), tool_name: 'Bash', tool_input: { command }, tool_response: {} }, sb.env, { ...base, ...extra });
  const mcp = (tool, input, agent = null) => hook('post-tool-use.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'PostToolUse', ...ag(agent), tool_name: `mcp__kronicle-lite__${tool}`, tool_input: input, tool_response: { content: [{ type: 'text', text: '{}' }] } }, sb.env, base);
  const pre = (command, agent = null, extra = {}) => hook('pulse.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'PreToolUse', ...ag(agent), tool_name: 'Bash', tool_input: { command } }, sb.env, { ...base, ...extra });
  const spawn = (agent) => hook('subagent-start.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'SubagentStart', ...ag(agent) }, sb.env, base);
  const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
  const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
  const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const log = () => (fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : '');
  return { sb, data, kl, put, read, start, post, mcp, pre, spawn, ctx, decision, reason, log };
}

test('pending gate: a delivered change stays a deny until the agent re-reads the current version — no acknowledgement step', opts, () => {
  const w = world();
  try {
    w.start();
    w.put(RB('staging-b'));
    assert.match(w.ctx(w.post('./bin/build')), /staging-b/, 'the push delivers the change');
    for (let i = 0; i < 3; i++) w.post(`other ${i}`);
    const d = w.pre('./bin/deploy --target staging-a');
    assert.equal(w.decision(d), 'deny', 'delivered is not reconciled');
    const r = w.reason(d);
    assert.match(r, /1 kronicle-lite change\(s\) you \(actor local-agent\) relied on are not re-read at their current version/);
    assert.match(r, /- runbook › Runbook › Deploy \(seq \d+, superseded\/behavioral; you read it at seq \d+\): read "Deploy with \.\/bin\/deploy --target staging-a\." → now "Deploy with \.\/bin\/deploy --target staging-b\."; diff: .*\[-staging-a\.-\]\{\+staging-b\.\+\}/);
    assert.match(r, /recall it again or read kronicle:\/\/docs\/runbook/, "kronicle-lite's own resolve hint");
    assert.match(r, /acknowledging a change, retrying, or reading as another actor does not/);
    assert.match(r, /only read-only Bash commands run \(cat, less, head, tail, ls, grep, rg, find/);
    assert.equal(w.pre('cat docs/runbook.md && git log --oneline -3').stdout, '', 'read-only calls run while pending');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny', 'still pending on a retry');
    w.read(); // recall through the MCP server = a read by local-agent
    assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 're-reading the current version cleared it');
    assert.match(w.log(), /pulse: denied .*1 pending for local-agent/);
  } finally { w.sb.cleanup(); }
});

test('pending gate: two changes since the read show the latest version; pulse_mode=warn only warns', opts, () => {
  const w = world({ CC_ANCHOR_PULSE_MODE: 'warn' });
  try {
    w.start();
    w.put(RB('staging-b'));
    w.put(RB('staging-c'));
    const r = w.pre('git push origin main');
    assert.equal(w.decision(r), null, 'warn mode never denies');
    assert.match(w.ctx(r), /pulse \(warn\): `git push origin main` is about to run, but 1 kronicle-lite change\(s\)/);
    assert.match(w.ctx(r), /now "Deploy with \.\/bin\/deploy --target staging-c\."/);
    w.read();
    assert.doesNotMatch(w.ctx(w.pre('git push origin main')), /not re-read/);
  } finally { w.sb.cleanup(); }
});

test('pending gate per agent: the union of the configured actor and every actor_id the agent used — naming another actor never clears it', opts, () => {
  const w = world();
  try {
    w.start(); w.post('p0');
    w.spawn('agent-s1');
    w.mcp('recall', { query: 'deploy target', actor_id: 'sub-s1' }, 'agent-s1'); // the hook learns s1's actor
    w.read('sub-s1');
    w.put(RB('staging-b'));
    const d = w.pre('./bin/deploy --target staging-a', 'agent-s1');
    assert.equal(w.decision(d), 'deny', 's1 read v1 as sub-s1 (and the server actor read it too)');
    assert.match(w.reason(d), /2 kronicle-lite change\(s\) you relied on \(as actors local-agent, sub-s1\)/);
    w.read('sub-s1');
    assert.match(w.reason(w.pre('./bin/deploy --target staging-b', 'agent-s1')), /1 kronicle-lite change\(s\) you \(actor local-agent\) relied on/, 's1 re-read as sub-s1: the configured actor is still pending');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny', 'the parent (local-agent) has not re-read: still denied');
    w.read();
    assert.equal(w.pre('./bin/deploy --target staging-b', 'agent-s1').stdout, '', 'both re-read: s1 clear');
    assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 'parent clear');
    // H2-03c: passing another actor_id to a non-read tool after reading as the server actor
    w.put(RB('staging-c'));
    w.mcp('get_system_state', { actor_id: 'claude' });
    const d2 = w.pre('./bin/deploy --target staging-c');
    assert.equal(w.decision(d2), 'deny', 'switching actor does not clear local-agent\'s pending');
    assert.match(w.reason(d2), /actor local-agent/);
    assert.match(w.log(), /used kronicle actor claude; gated on it as well as local-agent/);
  } finally { w.sb.cleanup(); }
});

test('pending gate fails closed: kronicle-lite failing while a change is known pending → deny on the last answer; nothing known pending → allow', opts, () => {
  const w = world({ CC_ANCHOR_PUSH_TIMEOUT: '2' });
  try {
    w.start();
    w.put(RB('staging-b'));
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny');
    const cfg = path.join(w.sb.run, 'push', 'sesspend.cfg');
    const lines = fs.readFileSync(cfg, 'utf8').split('\n');
    const hang = path.join(w.sb.base, 'hang-kl');
    fs.writeFileSync(hang, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });
    fs.writeFileSync(cfg, `${lines[0]}\n${hang}\n${lines[2]}\n`);
    const db = path.join(w.data, 'kronicle-lite.db');
    const later = new Date(Date.now() + 5000); fs.utimesSync(db, later, later); // the store "changed": the gate must re-read
    const t0 = Date.now();
    const d = w.pre('./bin/deploy --target staging-b', null, { CC_ANCHOR_KRONICLE_LITE_BIN: hang });
    assert.equal(w.decision(d), 'deny', 'timeout while pending: fail closed');
    assert.ok(Date.now() - t0 < 10000, `bounded: ${Date.now() - t0} ms`);
    assert.equal(w.pre('cat docs/runbook.md', null, { CC_ANCHOR_KRONICLE_LITE_BIN: hang }).stdout, '', 'read-only still runs');
    assert.match(w.log(), /timed out/);
  } finally { w.sb.cleanup(); }
});

test('push reminder: still pending push_reminder_after tool calls later, no world-changing attempt → exactly one reminder line', opts, () => {
  const w = world({ CC_ANCHOR_PUSH_REMINDER_AFTER: '3' });
  try {
    w.start();
    w.put(RB('staging-b'));
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(w.ctx(w.post(`step ${i}`)));
    assert.match(outs[0], /kronicle-lite changed while you were working/, 'delivered once');
    const rem = outs.map((o) => /cc-anchor: reminder — 1 kronicle-lite change\(s\) you relied on are still not re-read at their current version \(runbook\)/.test(o));
    assert.deepEqual(rem, [false, false, true, false, false, false], 'one reminder, on the 3rd call while pending');
    assert.equal(outs.filter((o) => /changed while you were working/.test(o)).length, 1, 'never re-pushed');
    // a new pending episode after a re-read gets its own reminder; a world-changing attempt suppresses it
    w.read();
    w.post('clear');
    w.put(RB('staging-c'));
    w.post('delivered');
    w.pre('./bin/deploy --target staging-c'); // attempted: the gate showed it
    const later = [];
    for (let i = 0; i < 4; i++) later.push(w.ctx(w.post(`after ${i}`)));
    assert.ok(later.every((o) => !/reminder/.test(o)), 'no reminder once a world-changing command was attempted');
  } finally { w.sb.cleanup(); }
});

test('pending detection: the agent actor comes from the kronicle server in .mcp.json (--actor)', opts, () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.sb.proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'kronicle-lite': { command: 'node', args: [KL, 'serve', '--data-dir', w.data, '--actor', 'agent-x'] } } }));
    const env = { CC_ANCHOR_KRONICLE: '', CC_ANCHOR_KRONICLE_DATA_DIR: '', CC_ANCHOR_PUSH_TIMEOUT: '30' };
    w.read('agent-x');
    hook('session-start.sh', { session_id: 'sess-mcp-0001', cwd: w.sb.proj, hook_event_name: 'SessionStart', source: 'startup' }, w.sb.env, { CC_ANCHOR_KRONICLE_LITE_BIN: KL, ...env });
    w.put(RB('staging-z'));
    const d = hook('pulse.sh', { session_id: 'sess-mcp-0001', cwd: w.sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: './bin/deploy --target staging-a' } }, w.sb.env, { CC_ANCHOR_KRONICLE_LITE_BIN: KL, ...env });
    assert.match(w.reason(d), /actor agent-x/);
    assert.equal(fs.readFileSync(path.join(w.sb.run, 'push', 'sessmcp0.cfg'), 'utf8').split('\n')[2], 'agent-x');
  } finally { w.sb.cleanup(); }
});
