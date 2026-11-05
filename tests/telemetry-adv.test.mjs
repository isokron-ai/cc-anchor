// Adversarial tests for audit telemetry (PR #7 review, reviewer's TEL-1…6
// turned into assertions, plus the 100 MB transcript blocker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SCRIPTS, sandbox, hook } from './helpers.mjs';

const CANARY = 'CANARY7f3a9q';
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const asst = (id, usage, content, ts = '2026-11-05T10:00:01.000Z', req = `req_${id}`) => ({ type: 'assistant', timestamp: ts, requestId: req, uuid: `u-${id}-${Math.random()}`, message: { id, model: 'claude-test-1', role: 'assistant', content, usage } });
const U = (i, o) => ({ input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: o });
const J = (a) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
const ids = (recs, ev = 'model_call') => recs.filter((x) => x.ev === ev).map((x) => x.message_id ?? x.tool_use_id);

function world(env = { CC_ANCHOR_OBSERVER: 'telemetry' }) {
  const sb = sandbox();
  const tx = path.join(sb.base, 'sess-tel-0001.jsonl');
  const out = path.join(sb.base, 'tel', 'telemetry.jsonl');
  const ev = (name, extra = {}, more = {}) => hook('telemetry.sh', { session_id: 'sess-tel-0001', transcript_path: tx, cwd: sb.proj, hook_event_name: name, ...extra }, sb.env, { CC_ANCHOR_TELEMETRY_FILE: out, ...env, ...more });
  return { sb, tx, out, ev, recs: () => read(out) };
}
function grepTree(dir, needle) {
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile() && fs.readFileSync(p).includes(needle)) hits.push(p); } };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}
const leftovers = (sb) => grepTreeNames(sb.base, /telemetry\.chunk|\/tmp\.\d+/);
function grepTreeNames(dir, re) {
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (re.test(p)) hits.push(p); if (fs.lstatSync(p).isDirectory()) walk(p); } };
  walk(dir);
  return hits;
}

test('TEL-1: no transcript content (prompt, tool input/output, assistant text) reaches the telemetry file or the run dir', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, J([
      { type: 'user', timestamp: '2026-11-05T10:00:00.000Z', message: { role: 'user', content: `prompt ${CANARY}-prompt` } },
      asst('m1', U(5, 5), [{ type: 'text', text: `${CANARY}-asst` }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `echo ${CANARY}-input` } }]),
      { type: 'user', timestamp: '2026-11-05T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `${CANARY}-output sk-ant-api03-${CANARY}AAAAAAAAAAAAAAAA` }] }] } },
      { type: 'user', timestamp: '2026-11-05T10:00:03.000Z', toolUseResult: { stdout: `${CANARY}-tur` }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: `${CANARY}-str` }] } },
    ]));
    assert.equal(w.ev('Stop').status, 0);
    assert.ok(w.recs().length > 0);
    assert.deepEqual([...grepTree(path.dirname(w.out), CANARY), ...grepTree(w.sb.proj, CANARY), ...grepTree(w.sb.home, CANARY)], []);
    assert.deepEqual(leftovers(w.sb), [], 'no staged copy of the transcript left behind');
  } finally { w.sb.cleanup(); }
});

test('TEL-2: one API response whose content-block entries straddle two flushes is counted once', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, J([asst('msg_X', U(100, 50), [{ type: 'thinking', thinking: '' }])]));
    w.ev('PreCompact', { trigger: 'auto' });
    fs.appendFileSync(w.tx, J([asst('msg_X', U(100, 50), [{ type: 'text', text: 'hi' }])]));
    w.ev('Stop');
    assert.deepEqual(ids(w.recs()), ['msg_X']);
    assert.equal(w.recs().filter((x) => x.ev === 'turn_usage').reduce((a, t) => a + t.input_tokens, 0), 100);
  } finally { w.sb.cleanup(); }
});

test('TEL-3: a truncated / rewritten transcript is re-baselined, nothing recounted', () => {
  const w = world();
  try {
    const L = [asst('msg_A', U(10, 1), [{ type: 'text', text: 'a' }]), asst('msg_B', U(20, 2), [{ type: 'text', text: 'b' }], '2026-11-05T10:00:02.000Z')];
    fs.writeFileSync(w.tx, J(L));
    w.ev('Stop');
    fs.writeFileSync(w.tx, J([L[0]]));
    w.ev('Stop');
    fs.appendFileSync(w.tx, J([L[1], asst('msg_C', U(1, 1), [{ type: 'text', text: 'c' }], '2026-11-05T10:00:03.000Z')]));
    w.ev('Stop');
    assert.deepEqual(ids(w.recs()), ['msg_A', 'msg_B', 'msg_C']);
    // same length, different head (a different conversation written over the file)
    fs.writeFileSync(w.tx, J([asst('msg_Z', U(3, 3), [{ type: 'text', text: 'z'.repeat(fs.statSync(w.tx).size) }])]));
    w.ev('Stop');
    assert.deepEqual(ids(w.recs()), ['msg_A', 'msg_B', 'msg_C', 'msg_Z'], 'rewritten file read from the start; only the new id counted');
  } finally { w.sb.cleanup(); }
});

test('TEL-4: hostile lines — malformed, deep JSON, negative / string / huge usage, array timestamp — never coerced to 0', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, J([
      '{not json',
      '['.repeat(20000) + ']'.repeat(20000),
      '{"type":"assistant","timestamp":"2026-11-05T10:00:01.000Z","message":{"id":"msg_P","model":"m","usage":{"input_tokens":-500,"cache_creation_input_tokens":"9999","cache_read_input_tokens":1e400,"output_tokens":-1}}}',
      asst('msg_Q', U(7, 7), [{ type: 'tool_use', id: '__proto__', name: 'Bash', input: {} }], ['x']),
      { type: 'user', timestamp: '2026-11-05T09:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '__proto__', content: 'z' }] } },
    ]));
    const r = w.ev('Stop');
    assert.deepEqual([r.status, r.stdout], [0, '']);
    const recs = w.recs();
    const p = recs.find((x) => x.message_id === 'msg_P');
    assert.deepEqual(p.invalid_usage.sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
    assert.deepEqual([p.input_tokens, p.output_tokens, p.cache_creation_input_tokens, p.cache_read_input_tokens], [null, null, null, null], 'rejected, not 0');
    const [t] = recs.filter((x) => x.ev === 'turn_usage');
    assert.equal(t.invalid_usage_calls, 1);
    assert.deepEqual([t.api_calls, t.input_tokens, t.output_tokens], [2, 7, 7], 'sums cover the valid response only');
    const q = recs.find((x) => x.ev === 'tool_call');
    assert.deepEqual([q.tool, q.latency_ms], ['Bash', null], 'array timestamp: no latency, no crash');
  } finally { w.sb.cleanup(); }
});

test('TEL-5: OBSERVER=off records nothing even with CC_ANCHOR_TELEMETRY=1, and no hook writes anything under off', () => {
  const w = world({ CC_ANCHOR_OBSERVER: 'off', CC_ANCHOR_TELEMETRY: '1' });
  try {
    fs.writeFileSync(w.tx, J([asst('msg_A', U(10, 1), [{ type: 'text', text: 'a' }])]));
    w.ev('Stop');
    assert.deepEqual(w.recs(), []);
    const sb2 = sandbox();
    try {
      const all = (d, s) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); s.add(p); if (fs.lstatSync(p).isDirectory()) all(p, s); } return s; };
      const before = all(sb2.base, new Set());
      for (const [s, e, extra] of [['session-start.sh', 'SessionStart', { source: 'startup' }], ['pre-tool-use.sh', 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(sb2.proj, 'a') } }], ['pulse.sh', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }], ['post-tool-use.sh', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }], ['user-prompt-submit.sh', 'UserPromptSubmit', { prompt: 'x' }], ['pre-compact.sh', 'PreCompact', { trigger: 'auto' }], ['stop.sh', 'Stop', {}], ['subagent-start.sh', 'SubagentStart', { agent_id: 'a1' }], ['subagent-stop.sh', 'SubagentStop', { agent_id: 'a1' }], ['instructions-loaded.sh', 'InstructionsLoaded', {}], ['task-created.sh', 'TaskCreated', {}], ['task-completed.sh', 'TaskCompleted', {}], ['telemetry.sh', 'Stop', {}]]) {
        const r = hook(s, { session_id: 's', cwd: sb2.proj, hook_event_name: e, ...extra }, sb2.env, { CC_ANCHOR_OBSERVER: 'off', CC_ANCHOR_TELEMETRY: '1' });
        assert.deepEqual([r.status, r.stdout], [0, ''], s);
      }
      assert.deepEqual([...all(sb2.base, new Set())].filter((p) => !before.has(p)), []);
    } finally { sb2.cleanup(); }
  } finally { w.sb.cleanup(); }
});

test('TEL-6: --scan handles odd paths, writes nothing, and keeps internal lines out of its output', () => {
  const sb = sandbox();
  try {
    const d = path.join(sb.base, 'ro dir\nx'); fs.mkdirSync(d);
    const tx = path.join(d, '-weird name $(touch PWNED).jsonl');
    fs.writeFileSync(tx, J([asst('msg_A', U(10, 1), [{ type: 'text', text: 'a' }])]));
    fs.mkdirSync(path.join(d, '-weird name $(touch PWNED)', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(d, '-weird name $(touch PWNED)', 'subagents', 'agent-zz 1.jsonl'), J([asst('msg_S', U(1, 1), [{ type: 'text', text: 's' }])]));
    fs.chmodSync(d, 0o555);
    try {
      const r = spawnSync('bash', [path.join(SCRIPTS, 'telemetry.sh'), '--scan', tx, '--subagents'], { encoding: 'utf8', cwd: d, env: { PATH: process.env.PATH, HOME: sb.home } });
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.split('\n').filter(Boolean);
      assert.ok(lines.every((l) => l.startsWith('{')), 'only JSON records');
      assert.deepEqual([...new Set(lines.map((l) => JSON.parse(l).agent_id))], [null, 'zz 1']);
      assert.ok(!fs.existsSync(path.join(d, 'PWNED')) && !fs.existsSync(path.join(sb.base, 'PWNED')));
      assert.deepEqual(fs.readdirSync(sb.home), []);
    } finally { fs.chmodSync(d, 0o755); }
  } finally { sb.cleanup(); }
});

test('TEL-7: overhead record only when something was flushed (or CC_ANCHOR_TELEMETRY_OVERHEAD=1)', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, J([asst('msg_A', U(10, 1), [{ type: 'text', text: 'a' }])]));
    w.ev('Stop'); w.ev('Stop'); w.ev('Stop');
    const n = () => w.recs().filter((x) => x.ev === 'telemetry_overhead').length;
    const clock = spawnSync('bash', ['-c', 'echo -n "${EPOCHREALTIME:-}"'], { encoding: 'utf8' }).stdout !== '';
    assert.equal(n(), clock ? 1 : 0, 'nothing new on the 2nd and 3rd Stop: no record');
    w.ev('Stop', {}, { CC_ANCHOR_TELEMETRY_OVERHEAD: '1' });
    assert.equal(n(), clock ? 2 : 0);
  } finally { w.sb.cleanup(); }
});

const HAS_TIMEOUT = spawnSync('timeout', ['1', 'true']).status === 0; // GNU coreutils; not on stock macOS

test('TEL-8: a 100 MB transcript under `timeout 10` — bounded work per hook, no exit 124, no leftover copy, no duplicates, valid JSONL, resumes', { timeout: 300000, skip: !HAS_TIMEOUT && 'no timeout(1)' }, () => {
  const w = world();
  try {
    const pad = 'x'.repeat(1900);
    const fd = fs.openSync(w.tx, 'w');
    let n = 0;
    for (let size = 0; size < 100 * 1024 * 1024; n++) {
      const l = JSON.stringify(asst(`msg_${n}`, U(1, 1), [{ type: 'text', text: pad }], '2026-11-05T10:00:01.000Z')) + '\n';
      fs.writeSync(fd, l); size += l.length;
    }
    fs.closeSync(fd);
    const run = () => spawnSync('timeout', ['10', 'bash', path.join(SCRIPTS, 'telemetry.sh')], {
      input: JSON.stringify({ session_id: 'sess-tel-0001', transcript_path: w.tx, cwd: w.sb.proj, hook_event_name: 'Stop' }),
      encoding: 'utf8', env: { ...w.sb.env, CC_ANCHOR_OBSERVER: 'telemetry', CC_ANCHOR_TELEMETRY_FILE: w.out },
    });
    const progress = [];
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const r = run();
      assert.equal(r.status, 0, `run ${i}: exit ${r.status} after ${Date.now() - t0} ms ${r.stderr.slice(0, 200)}`);
      assert.ok(Date.now() - t0 < 9000, `run ${i} took ${Date.now() - t0} ms`);
      const text = fs.readFileSync(w.out, 'utf8');
      assert.ok(text.endsWith('\n'));
      const got = ids(text.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      assert.equal(new Set(got).size, got.length, 'no duplicates');
      progress.push(got.length);
      assert.deepEqual(leftovers(w.sb), [], 'no leftover staged chunk');
    }
    // a fast machine may finish in the first run; otherwise the second one continues
    assert.ok(progress[0] > 0 && (progress[0] === n || progress[1] > progress[0]), `resumed: ${progress} of ${n}`);
  } finally { w.sb.cleanup(); }
});

test('TEL-9: a line longer than the window is skipped and reported by size; the lines around it are counted', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, J([asst('msg_1', U(1, 1), [{ type: 'text', text: 'a' }]),
      { type: 'user', timestamp: '2026-11-05T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(300000) }] } },
      asst('msg_2', U(2, 2), [{ type: 'text', text: 'b' }], '2026-11-05T10:00:03.000Z')]));
    const r = w.ev('Stop', {}, { CC_ANCHOR_TELEMETRY_WINDOW: '65536' });
    assert.equal(r.status, 0);
    const recs = w.recs();
    const why = () => JSON.stringify({ recs: recs.map((x) => [x.ev, x.message_id, x.bytes]), stderr: r.stderr, log: fs.existsSync(path.join(w.sb.run, 'log')) ? fs.readFileSync(path.join(w.sb.run, 'log'), 'utf8') : '', state: fs.readdirSync(path.join(w.sb.run, 'telemetry.state')) });
    assert.deepEqual(ids(recs), ['msg_1', 'msg_2'], why());
    const [o] = recs.filter((x) => x.ev === 'oversize_line');
    assert.ok(o && o.bytes > 300000, why());
  } finally { w.sb.cleanup(); }
});

test('TEL-10: a run killed mid-window (SIGKILL) leaves no torn line; the next run cleans its scratch and counts nothing twice', { skip: !HAS_TIMEOUT && 'no timeout(1)' }, () => {
  const w = world();
  try {
    const L = [];
    for (let i = 0; i < 4000; i++) L.push(asst(`msg_${i}`, U(1, 1), [{ type: 'text', text: 'p'.repeat(900) }]));
    fs.writeFileSync(w.tx, J(L));
    const env = { ...w.sb.env, CC_ANCHOR_OBSERVER: 'telemetry', CC_ANCHOR_TELEMETRY_FILE: w.out, CC_ANCHOR_TELEMETRY_WINDOW: '262144' };
    const input = JSON.stringify({ session_id: 'sess-tel-0001', transcript_path: w.tx, cwd: w.sb.proj, hook_event_name: 'Stop' });
    for (const ms of ['0.3', '0.6']) spawnSync('timeout', ['-s', 'KILL', ms, 'bash', path.join(SCRIPTS, 'telemetry.sh')], { input, env });
    // a lock left by a killed run belongs to a dead pid: taken over, not waited on
    const r = spawnSync('bash', [path.join(SCRIPTS, 'telemetry.sh')], { input, env, encoding: 'utf8' });
    assert.equal(r.status, 0);
    const text = fs.existsSync(w.out) ? fs.readFileSync(w.out, 'utf8') : '';
    const recs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)); // throws on a torn line
    const got = ids(recs);
    assert.equal(new Set(got).size, got.length, 'no duplicates');
    assert.equal(got.length, 4000, 'everything counted once the run completes');
    assert.deepEqual(fs.readdirSync(path.join(w.sb.run, 'telemetry.state')).filter((f) => /^tmp\.|^lock$|\.tmp\./.test(f)), []);
  } finally { w.sb.cleanup(); }
});

test('TEL-11: a live lock is never broken — the second run skips and the first finishes alone', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, J([asst('msg_1', U(1, 1), [{ type: 'text', text: 'a' }])]));
    const lock = path.join(w.sb.run, 'telemetry.state', 'lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`); // alive
    const t0 = Date.now();
    assert.equal(w.ev('Stop').status, 0);
    assert.ok(Date.now() - t0 < 6000);
    assert.deepEqual(w.recs(), [], 'skipped while another (live) run holds the lock');
    fs.rmSync(lock, { recursive: true });
    w.ev('Stop');
    assert.deepEqual(ids(w.recs()), ['msg_1']);
  } finally { w.sb.cleanup(); }
});
