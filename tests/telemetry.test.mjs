// Opt-in audit telemetry (scripts/telemetry.sh + telemetry.jq): provider-
// reported usage per API response and per turn, tool sizes/latency and
// compactions, read incrementally from the transcript; the observer-effect
// switch (CC_ANCHOR_OBSERVER); redaction; the offline --scan mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SCRIPTS, FIXTURES, sandbox, hook } from './helpers.mjs';

const FIX = path.join(FIXTURES, 'transcript-telemetry.jsonl');
const HAS_US_CLOCK = spawnSync('bash', ['-c', 'echo -n "${EPOCHREALTIME:-}"'], { encoding: 'utf8' }).stdout !== '';
const lines = () => fs.readFileSync(FIX, 'utf8').split('\n').filter(Boolean);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function world(env = { CC_ANCHOR_OBSERVER: 'telemetry' }) {
  const sb = sandbox();
  const tx = path.join(sb.base, 'sess-tel-0001.jsonl');
  const out = path.join(sb.base, 'tel', 'telemetry.jsonl');
  const ev = (name, extra = {}, more = {}) => hook('telemetry.sh', { session_id: 'sess-tel-0001', transcript_path: tx, cwd: sb.proj, hook_event_name: name, ...extra }, sb.env, { CC_ANCHOR_TELEMETRY_FILE: out, ...env, ...more });
  return { sb, tx, out, ev, recs: () => read(out) };
}

test('telemetry: usage as the provider reported it, one record per API response (content-block duplicates and synthetic messages dropped)', () => {
  const w = world();
  try {
    fs.writeFileSync(w.tx, lines().join('\n') + '\n');
    const r = w.ev('Stop');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'never writes to stdout');
    const recs = w.recs();
    const calls = recs.filter((x) => x.ev === 'model_call');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => [c.request_id, c.input_tokens, c.cache_creation_input_tokens, c.cache_read_input_tokens, c.output_tokens]), [['req_1', 10, 1000, 5000, 40], ['req_2', 3, 200, 6000, 25]]);
    const [turn] = recs.filter((x) => x.ev === 'turn_usage');
    assert.equal(turn.closed_by, 'Stop');
    assert.equal(turn.api_calls, 2);
    assert.deepEqual([turn.input_tokens, turn.cache_creation_input_tokens, turn.cache_read_input_tokens, turn.output_tokens], [13, 1200, 11000, 65]);
    assert.equal(turn.tool_response_tokens_est, 115, 'the estimate is its own field…');
    assert.equal(turn.input_tokens, 13, '…and never added to the provider input count');
    const tools = recs.filter((x) => x.ev === 'tool_call');
    assert.deepEqual(tools.map((t) => [t.tool, t.latency_ms, t.result_bytes, t.is_error, t.est_method]), [['mcp__srv__list_things', 750, 454, false, 'bytes/4'], ['Bash', 100, 4, true, 'bytes/4']]);
    const [c] = recs.filter((x) => x.ev === 'compaction');
    assert.deepEqual([c.trigger, c.pre_tokens, c.post_tokens, c.duration_ms], ['auto', 160000, 12000, 30000]);
    assert.ok(recs.every((x) => x.schema === 'cca.telemetry/1'));
    assert.ok(recs.filter((x) => x.ev !== 'telemetry_overhead').every((x) => x.session_id === 'sess-tel-0001' && x.observer === 'telemetry'));
    const [o] = recs.filter((x) => x.ev === 'telemetry_overhead');
    if (HAS_US_CLOCK) {
      assert.equal(o.hook, 'Stop');
      assert.equal(typeof o.hook_ms, 'number');
    } else assert.equal(o, undefined, 'bash < 5 (macOS /bin/bash 3.2): no clock without a fork, so no overhead record');
  } finally { w.sb.cleanup(); }
});

test('telemetry: incremental — each API response is counted once across hooks; a half-written line waits for the next run', () => {
  const w = world();
  try {
    const L = lines();
    fs.writeFileSync(w.tx, L.slice(0, 4).join('\n') + '\n'); // call 1 (2 entries) + its tool result + call 2 …
    w.ev('PreCompact', { trigger: 'auto' });
    const tail = L.slice(4).join('\n') + '\n';
    fs.appendFileSync(w.tx, tail.slice(0, 40)); // … and a partial line
    w.ev('Stop');
    fs.appendFileSync(w.tx, tail.slice(40));
    w.ev('Stop');
    w.ev('Stop'); // nothing new: no records
    const recs = w.recs();
    const calls = recs.filter((x) => x.ev === 'model_call');
    assert.deepEqual(calls.map((c) => c.request_id), ['req_1', 'req_2'], 'no response counted twice');
    const turns = recs.filter((x) => x.ev === 'turn_usage');
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.closed_by), ['PreCompact', 'Stop']);
    const sum = (k) => turns.reduce((a, t) => a + t[k], 0);
    assert.equal(sum('output_tokens'), 65);
    assert.equal(sum('cache_read_input_tokens'), 11000);
    assert.equal(recs.filter((x) => x.ev === 'compact_start').length, 1);
    assert.equal(recs.filter((x) => x.ev === 'compact_start')[0].trigger, 'auto');
    const bash = recs.find((x) => x.ev === 'tool_call' && x.tool_use_id === 'toolu_B');
    assert.equal(bash.tool, 'Bash');
  } finally { w.sb.cleanup(); }
});

test('telemetry: SubagentStop reads the subagent transcript (agent_id); SessionEnd flushes the session and every subagent file', () => {
  const w = world();
  try {
    const sub = path.join(w.tx.replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const a1 = path.join(sub, 'agent-a1.jsonl');
    fs.writeFileSync(a1, lines().join('\n') + '\n');
    fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), lines().join('\n') + '\n');
    fs.writeFileSync(w.tx, lines().slice(0, 4).join('\n') + '\n');
    const none = w.ev('SubagentStop', { agent_id: 'a0' }); // no agent_transcript_path: nothing to read
    assert.deepEqual([none.status, none.stderr], [0, ''], 'empty file list is fine on bash 3.2 + set -u too');
    w.ev('SubagentStop', { agent_id: 'a1', agent_transcript_path: a1 });
    let recs = w.recs();
    assert.ok(recs.filter((x) => x.ev === 'model_call').every((x) => x.agent_id === 'a1'));
    assert.equal(recs.filter((x) => x.ev === 'turn_usage').length, 1);
    w.ev('SessionEnd', { reason: 'other' });
    recs = w.recs();
    const turns = recs.filter((x) => x.ev === 'turn_usage');
    assert.deepEqual(turns.map((t) => t.agent_id), ['a1', null, 'a2'], 'a1 is not counted again; main and a2 flushed');
  } finally { w.sb.cleanup(); }
});

test('telemetry: off unless enabled; never copies content; secrets in names are redacted', () => {
  const w = world({});
  try {
    const L = lines().map((l) => l.replace('mcp__srv__list_things', 'mcp__srv__ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'));
    fs.writeFileSync(w.tx, L.join('\n') + '\n');
    w.ev('Stop');
    assert.ok(!fs.existsSync(w.out), 'not enabled: nothing written');
    assert.ok(!fs.existsSync(path.join(w.sb.run, 'telemetry.off')), 'not enabled: no state either');
    w.ev('Stop', {}, { CC_ANCHOR_TELEMETRY: '1' });
    const text = fs.readFileSync(w.out, 'utf8');
    assert.doesNotMatch(text, /SECRET|ghp_ABCDEF|xxxxxxxxxx|boom|deploy it/, 'no transcript content, secrets redacted');
    assert.match(text, /mcp__srv__\[REDACTED\]/);
    assert.match(text, /"observer":"telemetry\+anchors"/, 'CC_ANCHOR_TELEMETRY=1 alone: anchors stay on');
  } finally { w.sb.cleanup(); }
});

test('observer switch: off and telemetry make the cc-anchor hooks no-ops; telemetry+anchors keeps them', () => {
  for (const [mode, active] of [['off', false], ['telemetry', false], ['telemetry+anchors', true], ['', true]]) {
    const sb = sandbox();
    try {
      const env = { CC_ANCHOR_OBSERVER: mode };
      const s = hook('session-start.sh', { session_id: 'sess-obs-0001', cwd: sb.proj, hook_event_name: 'SessionStart', source: 'compact' }, sb.env, env);
      hook('post-tool-use.sh', { session_id: 'sess-obs-0001', cwd: sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(sb.proj, 'a.md') }, tool_response: {} }, sb.env, env);
      assert.equal(s.status, 0);
      assert.equal(fs.existsSync(sb.card), active, `${mode || 'unset'}: card written = ${active}`);
      assert.equal(sb.trailLines().length > 0, active, `${mode || 'unset'}: trail = ${active}`);
      if (!active) assert.equal(s.stdout, '', `${mode}: nothing injected`);
    } finally { sb.cleanup(); }
  }
});

test('telemetry --scan: the same records offline (no hook, no observer effect); --kronicle maps to draft kronicle-lite audit events', () => {
  const sb = sandbox();
  try {
    const tx = path.join(sb.base, 'sess-scan.jsonl');
    fs.writeFileSync(tx, lines().join('\n') + '\n');
    const sub = path.join(sb.base, 'sess-scan', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-z9.jsonl'), lines().join('\n') + '\n');
    const run = (...a) => spawnSync('bash', [path.join(SCRIPTS, 'telemetry.sh'), '--scan', tx, ...a], { encoding: 'utf8', env: sb.env });
    const r = run('--subagents');
    assert.equal(r.status, 0, r.stderr);
    const recs = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs.filter((x) => x.ev === 'model_call').length, 4);
    assert.deepEqual(recs.filter((x) => x.ev === 'turn_usage').map((t) => [t.agent_id, t.closed_by]), [[null, 'scan'], ['z9', 'scan']]);
    const k = run('--kronicle').stdout.trim().split('\n').map((l) => JSON.parse(l));
    const cm = k.filter((x) => x.event_type === 'call_measured');
    assert.equal(cm.length, 2);
    assert.equal(cm[0].schema, 'kronicle.audit/0-draft');
    assert.equal(cm[0].boundary, 'model');
    assert.deepEqual([cm[0].payload.tool, cm[0].payload.result_bytes, cm[0].payload.status, cm[1].payload.status], ['mcp__srv__list_things', 454, 'ok', 'error']);
    assert.equal(k.filter((x) => x.event_type === 'turn_usage').length, 1);
    assert.equal(run().status, 0);
    assert.equal(spawnSync('bash', [path.join(SCRIPTS, 'telemetry.sh'), '--scan', path.join(sb.base, 'missing.jsonl')], { encoding: 'utf8' }).status, 2);
  } finally { sb.cleanup(); }
});
