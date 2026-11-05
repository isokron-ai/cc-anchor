// Adversarial tests for the per-agent ledger (PR #6 review, reviewer's
// ADV-1…9 turned into assertions). Gate bypasses: forged or partial reads
// clearing an owed change, agent-writable ledger state, a lock broken under
// load, jq missing. Runs against a kronicle-lite with `pending` (>= 0.8.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, SCRIPTS, sandbox, hook } from './helpers.mjs';

const CANDIDATES = [process.env.KRONICLE_LITE_PENDING_CLI, process.env.KRONICLE_LITE_CLI, path.join(ROOT, 'node_modules', 'kronicle-lite', 'dist', 'cli.js')];
const hasPending = (cli) => spawnSync('node', [cli, 'pending', '--actor', 'probe', '--json', '--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'klcap-'))], { encoding: 'utf8' }).status === 0;
const KL = CANDIDATES.find((f) => f && fs.existsSync(f) && hasPending(f));
const opts = { skip: !KL && 'no kronicle-lite with `pending` (>= 0.8.0) found; set KRONICLE_LITE_PENDING_CLI' };

const RB = (target, extra = '') => `# Runbook\n\n## Deploy\n\nDeploy with ./bin/deploy --target ${target}.\n${extra}`;
const RBR = '\n## Rollback\n\nRoll back with ./bin/rollback --hard.\n';
const SID = 'sess-ledg-0001';

function world(initial = RB('staging-a')) {
  const sb = sandbox();
  const data = path.join(sb.base, 'kl');
  const kl = (...a) => spawnSync('node', [KL, ...a, '--data-dir', data], { encoding: 'utf8', cwd: sb.proj });
  const put = (content) => { const f = path.join(sb.base, `rb-${Math.random()}.md`); fs.writeFileSync(f, content); assert.equal(kl('put', 'runbook', f).status, 0); };
  const base = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: KL, CC_ANCHOR_KRONICLE_DATA_DIR: data, CC_ANCHOR_PUSH_TIMEOUT: '30' };
  const ag = (agent) => (agent ? { agent_id: agent, agent_type: 'general-purpose' } : {});
  const ev = (script, name, agent, extra = {}, env = {}) => hook(script, { session_id: SID, cwd: sb.proj, hook_event_name: name, ...ag(agent), ...extra }, sb.env, { ...base, ...env });
  // a real `kronicle-lite get` (as the shared actor), shown to the hook as `cmd`'s result, optionally filtered
  const getDoc = (agent = null, cmd = 'kronicle-lite get runbook', filter = (s) => s) => {
    const r = kl('get', 'runbook', '--actor', 'local-agent');
    assert.equal(r.status, 0);
    return ev('post-tool-use.sh', 'PostToolUse', agent, { tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: filter(r.stdout), stderr: '', interrupted: false } });
  };
  const bash = (command, stdout, agent = null, stderr = '') => ev('post-tool-use.sh', 'PostToolUse', agent, { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr, interrupted: false } });
  const post = (command, agent = null) => ev('post-tool-use.sh', 'PostToolUse', agent, { tool_name: 'Bash', tool_input: { command }, tool_response: {} });
  const pre = (command, agent = null, env = {}) => ev('pulse.sh', 'PreToolUse', agent, { tool_name: 'Bash', tool_input: { command } }, env);
  const preWrite = (file, tool = 'Write', agent = null) => ev('pre-tool-use.sh', 'PreToolUse', agent, { tool_name: tool, tool_input: { file_path: file, content: '', old_string: 'a', new_string: 'b' } });
  const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
  const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const push = path.join(sb.run, 'push');
  const log = () => (fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : '');
  put(initial);
  return { sb, kl, put, ev, getDoc, bash, post, pre, preWrite, decision, reason, push, base, data, log };
}

// the main agent owes the change; s1 re-read it (the shared actor's count is 0)
function setupOwed(w, next = RB('staging-b')) {
  w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
  w.getDoc();
  w.ev('subagent-start.sh', 'SubagentStart', 'agent-s1');
  w.getDoc('agent-s1');
  w.post('p0');
  w.put(next);
  w.post('./bin/build');
  w.getDoc('agent-s1');
}

test('ADV-1: the ledger is not agent-writable — Write/Edit into the run dir is denied, and a truncated ledger fails closed', opts, () => {
  const w = world();
  try {
    setupOwed(w);
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny');
    const owed = path.join(w.push, 'sessledg.owed');
    assert.ok(fs.existsSync(owed));
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const d = w.preWrite(owed, tool);
      assert.equal(w.decision(d), 'deny', `${tool} on the ledger`);
      assert.match(w.reason(d), /cc-anchor's own state/);
    }
    assert.equal(w.decision(w.preWrite(path.join(w.push, 'sessledg.off'))), 'deny', 'nor the push off-switch');
    fs.writeFileSync(owed, ''); // done anyway (outside the hooks)
    const d = w.pre('./bin/deploy --target staging-b');
    assert.equal(w.decision(d), 'deny', 'truncated ledger: fail closed');
    assert.match(w.reason(d), /ledger .*(changed outside cc-anchor|tampered)/);
    fs.rmSync(owed);
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny', 'deleted ledger: fail closed');
  } finally { w.sb.cleanup(); }
});

test('ADV-1b: Bash writes into the run dir are denied even with nothing pending; reading it is fine', opts, () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc(); w.post('p0');
    assert.equal(w.pre('./bin/deploy --target staging-a').stdout, '', 'nothing pending: runs');
    for (const c of [': > .claude/cc-anchor/push/sessledg.owed', `touch ${path.join(w.push, 'sessledg.off')}`, 'rm -rf .claude/cc-anchor']) {
      assert.equal(w.decision(w.pre(c)), 'deny', c);
    }
    assert.equal(w.pre('cat .claude/cc-anchor/log').stdout, '', 'read-only access runs');
  } finally { w.sb.cleanup(); }
});

test('ADV-2: a garbage line in the ledger fails closed', opts, () => {
  const w = world();
  try {
    setupOwed(w);
    const owed = path.join(w.push, 'sessledg.owed');
    fs.writeFileSync(owed, fs.readFileSync(owed, 'utf8').replace(/^\{/, '{,'));
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny');
  } finally { w.sb.cleanup(); }
});

test('ADV-3: a read-only echo of the current text is not a re-read', opts, () => {
  const w = world();
  try {
    setupOwed(w);
    const cmd = 'echo Deploy with ./bin/deploy --target staging-b. kronicle-lite get runbook';
    w.bash(cmd, 'Deploy with ./bin/deploy --target staging-b. kronicle-lite get runbook\n');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny');
    w.getDoc();
    assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 'a real get clears it');
  } finally { w.sb.cleanup(); }
});

test('ADV-3b: a plain get whose read kronicle-lite never recorded does not clear the ledger (kronicle-lite confirms)', opts, () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc(); w.post('p0');
    w.put(RB('staging-b'));
    w.post('./bin/build'); // nobody re-read: pending(local-agent) = 1, the main agent owes it
    const owed = path.join(w.push, 'sessledg.owed');
    assert.match(fs.readFileSync(owed, 'utf8'), /staging-b/);
    w.bash('kronicle-lite get runbook', RB('staging-b')); // shown output, but kronicle-lite recorded no read
    assert.match(fs.readFileSync(owed, 'utf8'), /staging-b/, 'still owed');
    assert.doesNotMatch(w.log(), /the main agent re-read/);
    w.getDoc();
    assert.ok(!fs.existsSync(owed) || !/staging-b/.test(fs.readFileSync(owed, 'utf8')), 'a recorded read clears it');
  } finally { w.sb.cleanup(); }
});

test('ADV-4: a removal is not cleared by a partial read (| head), an erroring get, or a command that only mentions the doc', opts, () => {
  const w = world(RB('staging-a', RBR));
  try {
    setupOwed(w, RB('staging-a'));
    const gate = () => w.decision(w.pre('./bin/deploy --target staging-a'));
    assert.equal(gate(), 'deny');
    w.getDoc(null, 'kronicle-lite get runbook | head -3', (s) => s.split('\n').slice(0, 3).join('\n'));
    assert.equal(gate(), 'deny', '| head');
    w.bash('kronicle-lite get runbook --data-dir /nope', '', null, 'error: ENOENT: no such file or directory, open /nope/kronicle.db');
    assert.equal(gate(), 'deny', 'erroring get');
    w.bash('grep -n "kronicle-lite get runbook" README.md', 'README.md:12:  run kronicle-lite get runbook first\n');
    assert.equal(gate(), 'deny', 'grep mentioning the doc');
    w.getDoc();
    assert.equal(w.pre('./bin/deploy --target staging-a').stdout, '', 'a real full get clears the removal');
  } finally { w.sb.cleanup(); }
});

test('ADV-5: agents clear only their own ledger; hostile agent ids stay inside push/', opts, () => {
  const w = world();
  try {
    setupOwed(w);
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s2');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b', 'agent-s2')), 'deny');
    w.getDoc();
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b', 'agent-s2')), 'deny', 's2 still owes after main re-read');
    w.ev('subagent-start.sh', 'SubagentStart', '../../x');
    assert.ok(!fs.existsSync(path.join(w.sb.run, 'x.owed')) && !fs.readdirSync(w.push).some((f) => f.includes('..')));
  } finally { w.sb.cleanup(); }
});

test('ADV-6: jq missing with kronicle-lite in use — pulse fails closed and says why', opts, () => {
  const w = world();
  try {
    setupOwed(w);
    const bin = path.join(w.sb.base, 'nojq'); fs.mkdirSync(bin);
    for (const t of ['bash', 'node', 'cat', 'mkdir', 'rm', 'mv', 'grep', 'sed', 'date', 'sort', 'head', 'tail', 'wc', 'cp', 'tr', 'od', 'sleep', 'rmdir', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'cut', 'stat', 'touch', 'mktemp', 'uname', 'git', 'timeout', 'env', 'dirname', 'basename', 'ps', 'kill']) {
      const p = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(); if (p) fs.symlinkSync(p, path.join(bin, t));
    }
    const r = hook('pulse.sh', { session_id: SID, cwd: w.sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: './bin/deploy --target staging-b' } }, { ...w.sb.env, PATH: bin }, w.base);
    assert.equal(w.decision(r), 'deny');
    assert.match(w.reason(r), /jq/);
    const plain = sandbox();
    try {
      const r2 = hook('pulse.sh', { session_id: 's', cwd: plain.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'make' } }, { ...plain.env, PATH: bin }, {});
      assert.equal(r2.stdout, '', 'no kronicle-lite in this project: nothing to gate, no deny');
    } finally { plain.cleanup(); }
  } finally { w.sb.cleanup(); }
});

test('ADV-7: 12 parallel agents — no live lock is ever broken, ledgers stay valid, non-readers stay denied', opts, async () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc();
    const N = 12;
    for (let i = 0; i < N; i++) w.ev('subagent-start.sh', 'SubagentStart', `agent-p${i}`);
    w.post('p0');
    const run = (script, payload) => new Promise((res) => {
      const c = spawn('bash', [path.join(SCRIPTS, script)], { env: { ...w.sb.env, ...w.base } });
      c.stdin.end(JSON.stringify(payload)); c.on('close', res); c.stdout.resume(); c.stderr.resume();
    });
    for (const t of ['staging-b', 'staging-c']) {
      w.put(RB(t));
      const r = w.kl('get', 'runbook', '--actor', 'local-agent');
      await Promise.all([...Array(N).keys()].flatMap((i) => [
        run('post-tool-use.sh', { session_id: SID, cwd: w.sb.proj, hook_event_name: 'PostToolUse', agent_id: `agent-p${i}`, agent_type: 'x', tool_name: 'Bash', tool_input: { command: './bin/build' }, tool_response: {} }),
        i % 3 === 0 ? run('subagent-stop.sh', { session_id: SID, cwd: w.sb.proj, hook_event_name: 'SubagentStop', agent_id: `agent-p${i}`, agent_type: 'x' }) : null,
        i % 2 === 0 ? run('post-tool-use.sh', { session_id: SID, cwd: w.sb.proj, hook_event_name: 'PostToolUse', agent_id: `agent-p${i}`, agent_type: 'x', tool_name: 'Bash', tool_input: { command: 'kronicle-lite get runbook' }, tool_response: { stdout: r.stdout, stderr: '' } }) : null,
        run('post-tool-use.sh', { session_id: SID, cwd: w.sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: './bin/x' }, tool_response: {} }),
      ].filter(Boolean)));
    }
    const bad = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { walk(p); continue; } if (/\.owed$/.test(f)) for (const l of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) { try { JSON.parse(l); } catch { bad.push(`${f}: ${l.slice(0, 60)}`); } } if (/\.(owed|done|reads)\.\d+$/.test(f)) bad.push(`leftover tmp ${f}`); } };
    walk(w.push);
    assert.deepEqual(bad, []);
    assert.doesNotMatch(w.log(), /broke a stale ledger lock|updating without it/, 'never broken while its owner lives, never written unlocked');
    for (let i = 1; i < N; i += 2) assert.equal(w.decision(w.pre('./bin/deploy --target staging-c', `agent-p${i}`)), 'deny', `agent-p${i} never re-read`);
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-c')), 'deny', 'main never re-read');
  } finally { w.sb.cleanup(); }
});

test('ADV-7b: a ledger lock held by a live process makes the update wait, then fail closed (deny) instead of writing unlocked', opts, () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc(); w.post('p0');
    const lock = path.join(w.push, 'sessledg.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`); // this test runner: alive
    w.put(RB('staging-b'));
    w.post('./bin/build'); // the feed cannot take the lock
    const d = w.pre('./bin/deploy --target staging-b');
    assert.equal(w.decision(d), 'deny');
    assert.match(w.log(), /ledger lock busy .*skipped/);
    fs.rmSync(lock, { recursive: true });
    w.getDoc();
    assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 'lock free again: the queued feed applied, the re-read cleared it');
  } finally { w.sb.cleanup(); }
});

test('ADV-8: a subagent re-reading before any push does not leave the main agent clear', opts, () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc();
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s1');
    w.getDoc('agent-s1');
    w.post('p0'); w.post('p0', 'agent-s1');
    w.put(RB('staging-b'));
    w.getDoc('agent-s1');
    w.post('./bin/build');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b')), 'deny');
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s3');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b', 'agent-s3')), 'deny');
  } finally { w.sb.cleanup(); }
});
