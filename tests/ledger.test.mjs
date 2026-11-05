// 0.5.2 (L2-05): per-agent reconciliation. kronicle-lite counts reads per
// ACTOR, and the agents of one Claude Code session normally share the MCP
// server's actor, so one agent's re-read cleared the gate for all of them.
// cc-anchor now keeps a ledger per agent_id (scripts/owed.jq): each agent is
// gated until ITS OWN tool result shows the current version. Runs against a
// kronicle-lite CLI with `pending` (>= 0.8.0), like pending.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, SCRIPTS, sandbox, hook } from './helpers.mjs';

const CANDIDATES = [process.env.KRONICLE_LITE_PENDING_CLI, process.env.KRONICLE_LITE_CLI, path.join(ROOT, 'node_modules', 'kronicle-lite', 'dist', 'cli.js')];
const hasPending = (cli) => spawnSync('node', [cli, 'pending', '--actor', 'probe', '--json', '--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'klcap-'))], { encoding: 'utf8' }).status === 0;
const KL = CANDIDATES.find((f) => f && fs.existsSync(f) && hasPending(f));
const opts = { skip: !KL && 'no kronicle-lite with `pending` (>= 0.8.0) found; set KRONICLE_LITE_PENDING_CLI' };

const RB = (target) => `# Runbook\n\n## Deploy\n\nDeploy with ./bin/deploy --target ${target}.\n`;
const SID = 'sess-ledg-0001';

function world() {
  const sb = sandbox();
  const data = path.join(sb.base, 'kl');
  const kl = (...a) => spawnSync('node', [KL, ...a, '--data-dir', data], { encoding: 'utf8', cwd: sb.proj });
  const put = (content) => { const f = path.join(sb.base, `rb-${Math.random()}.md`); fs.writeFileSync(f, content); assert.equal(kl('put', 'runbook', f).status, 0); };
  const base = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: KL, CC_ANCHOR_KRONICLE_DATA_DIR: data, CC_ANCHOR_PUSH_TIMEOUT: '30' };
  const ag = (agent) => (agent ? { agent_id: agent, agent_type: 'general-purpose' } : {});
  const ev = (script, name, agent, extra = {}) => hook(script, { session_id: SID, cwd: sb.proj, hook_event_name: name, ...ag(agent), ...extra }, sb.env, base);
  // `kronicle-lite get runbook` in Bash, as `agent` (the shared actor): a real read + the result the hook sees
  const getDoc = (agent = null) => {
    const r = kl('get', 'runbook', '--actor', 'local-agent');
    assert.equal(r.status, 0);
    return ev('post-tool-use.sh', 'PostToolUse', agent, { tool_name: 'Bash', tool_input: { command: 'kronicle-lite get runbook' }, tool_response: { stdout: r.stdout, stderr: '', interrupted: false } });
  };
  const post = (command, agent = null) => ev('post-tool-use.sh', 'PostToolUse', agent, { tool_name: 'Bash', tool_input: { command }, tool_response: {} });
  const pre = (command, agent = null) => ev('pulse.sh', 'PreToolUse', agent, { tool_name: 'Bash', tool_input: { command } });
  const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
  const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const log = () => (fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : '');
  put(RB('staging-a'));
  return { sb, kl, put, ev, getDoc, post, pre, decision, reason, log };
}

test('L2-05: one agent re-reading a change does not clear it for the other agents of the session (shared actor)', opts, () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc(); // main agent read v1
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s1');
    w.getDoc('agent-s1'); // s1 read v1 too
    w.post('p0');
    w.put(RB('staging-b'));
    w.post('./bin/build'); // the push: kronicle-lite pending(local-agent) = 1, fed to both ledgers
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-b', 'agent-s1')), 'deny', 's1 has not re-read');
    w.getDoc('agent-s1'); // s1 re-reads: kronicle-lite's per-actor count drops to 0 for everyone
    assert.equal(w.pre('./bin/deploy --target staging-b', 'agent-s1').stdout, '', 's1 re-read the current version itself: clear');
    const d = w.pre('./bin/deploy --target staging-b');
    assert.equal(w.decision(d), 'deny', 'the main agent has not re-read it: still denied although pending(local-agent) is 0');
    assert.match(w.reason(d), /not re-read by you \(the main agent\)/);
    assert.match(w.reason(d), /now "Deploy with \.\/bin\/deploy --target staging-b\."/);
    assert.match(w.reason(d), /another agent of this session re-reading it does not/);
    assert.equal(w.pre('cat docs/runbook.md').stdout, '', 'read-only still runs');
    w.getDoc(); // the main agent re-reads
    assert.equal(w.pre('./bin/deploy --target staging-b').stdout, '', 'main agent clear after its own re-read');
    assert.match(w.log(), /ledger: the main agent re-read 1 change\(s\) at the current version; 0 still owed/);
  } finally { w.sb.cleanup(); }
});

test('L2-05: a subagent started after the change was consumed inherits what the session still owes; a stopped one gets it back on resume', opts, () => {
  const w = world();
  try {
    w.ev('session-start.sh', 'SessionStart', null, { source: 'startup' });
    w.getDoc();
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s1');
    w.post('p0');
    w.put(RB('staging-c'));
    w.post('./bin/build'); // delivered to the main agent; every agent owes it
    w.getDoc('agent-s1'); // s1 re-reads: pending(local-agent) = 0, the main agent still owes it
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s2');
    const d = w.pre('./bin/deploy --target staging-c', 'agent-s2');
    assert.equal(w.decision(d), 'deny', 'the new subagent got no push and kronicle-lite counts nothing pending: it inherits the owed re-read');
    assert.match(w.reason(d), /not re-read by you \(subagent agent-s2\)/);
    w.ev('subagent-stop.sh', 'SubagentStop', 'agent-s2');
    w.ev('subagent-start.sh', 'SubagentStart', 'agent-s2');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-c', 'agent-s2')), 'deny', 'resumed with the same agent_id: still owed');
    w.getDoc('agent-s2');
    assert.equal(w.pre('./bin/deploy --target staging-c', 'agent-s2').stdout, '', 's2 clear after its own re-read');
    assert.equal(w.decision(w.pre('./bin/deploy --target staging-c')), 'deny', 'the main agent still owes it');
  } finally { w.sb.cleanup(); }
});

test('owed.jq: merge dedupes by key and drops keys already re-read; clear prints tagged lines', () => {
  const jq = (args, input = '') => spawnSync('jq', [...args, '-f', path.join(SCRIPTS, 'owed.jq')], { input, encoding: 'utf8' });
  const m = jq(['-nr', '--arg', 'mode', 'merge', '--arg', 'owed', '{"k":"c:a"}\n{"k":"c:a"}\nnot json\n{"k":"c:b"}', '--arg', 'done', 'c:b']);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(m.stdout.trim(), '{"k":"c:a"}');
  const item = { k: 'c:B2', slug: 'runbook', seq: 3, cur: 'B2', tb: null, rd: 'B1', new: 'Deploy to west.', old: 'Deploy to east.', line: '- runbook' };
  const payload = { tool_name: 'mcp__kronicle-lite__recall', tool_response: { content: [{ type: 'text', text: JSON.stringify({ hits: [{ block_id: 'B2', doc_slug: 'runbook', content: 'Deploy to west.', status: 'live' }] }) }] } };
  const c = jq(['-r', '--arg', 'mode', 'clear', '--arg', 'owed', JSON.stringify(item)], JSON.stringify(payload));
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(c.stdout.trim().split('\n').sort(), ['C\tc:B2', 'F\tB1', 'R\tB2']);
  const none = jq(['-r', '--arg', 'mode', 'clear', '--arg', 'owed', JSON.stringify(item)], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' } }));
  assert.equal(none.stdout.trim(), `O\t${JSON.stringify(item)}`, 'a result without the content clears nothing');
});
