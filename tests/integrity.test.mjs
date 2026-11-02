// Release fix (stress S2): a corrupt kronicle-lite store must not look like
// "nothing to push".
//   * integrity.ok === false in an orient result → one top-priority warning
//     per distinct problem, no retractions from the corrupt store, and the
//     pulse lets only read-only Bash calls run until a fresh read says ok
//     (pulse_mode=warn still warns). Stub CLI until kronicle-lite returns
//     integrity:{ok:false, problem, seq} instead of throwing.
//   * kronicle unavailable (missing / failing / timing out / non-JSON) stays
//     fail-open, is logged, and after push_offline_after consecutive calls
//     (default 20) one "feed offline" advisory is pushed. Real CLI against a
//     hand-corrupted store (agent-memory-bench stress/kl/tamper-json.sh), and
//     a stub that prints non-JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { ROOT, sandbox, hook } from './helpers.mjs';

const SID = 'sess-int-0001';
function drive(sb, base) {
  const post = (command = 'make', extra = {}, agent = null) => hook('post-tool-use.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'PostToolUse', ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}), tool_name: 'Bash', tool_input: { command }, tool_response: {} }, sb.env, { ...base, ...extra });
  const pre = (command, extra = {}) => hook('pulse.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, sb.env, { ...base, ...extra });
  const start = () => hook('session-start.sh', { session_id: SID, cwd: sb.proj, hook_event_name: 'SessionStart', source: 'startup' }, sb.env, base);
  const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
  const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
  const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const log = () => (fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : '');
  return { post, pre, start, ctx, decision, reason, log };
}

// ── stub CLI speaking the coming kronicle-lite contract ──────────────────
function stubWorld(extraEnv = {}) {
  const sb = sandbox();
  const state = path.join(sb.base, 'state.json');
  const cli = path.join(sb.base, 'kl-stub.mjs');
  fs.writeFileSync(cli, `import fs from 'node:fs';
const a = process.argv.slice(2); const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const focus = a[a.indexOf('--focus') + 1];
fs.appendFileSync(${JSON.stringify(state)} + '.calls', focus + '\\n');
const head = { seq: st.seq, hash: 'h' };
if (focus === 'pulse') console.log(JSON.stringify({ cursor: 'sxt1.c' + st.seq, cursor_compact: 'sxt1c.' + st.seq + '.x', head, integrity: null, retractions: null }));
else console.log(JSON.stringify({ cursor: 'sxt1.c' + st.seq, head, integrity: st.integrity, retractions: st.retractions || [], ...(st.pending_count != null ? { pending_count: st.pending_count, pending_actor: st.pending_actor, pending: st.pending } : {}) }));
`);
  const set = (o) => fs.writeFileSync(state, JSON.stringify(o));
  set({ seq: 5, integrity: { ok: true, events_checked: 5, blocks_checked: 3, problem: null }, retractions: [] });
  const base = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: cli, CC_ANCHOR_KRONICLE_DATA_DIR: path.join(sb.base, 'no-store'), ...extraEnv };
  return { sb, set, base, calls: () => (fs.existsSync(state + '.calls') ? fs.readFileSync(state + '.calls', 'utf8').trim().split('\n') : []), ...drive(sb, base) };
}
const R = { seq: 7, event_type: 'block.superseded', kind: 'supersession', severity: 'behavioral', doc_slug: 'runbook', heading_path: ['Deploy'], old_text: 'target: a', new_text: 'target: b', diff: 'target: [-a-]{+b+}', reason_line: 'x' };
const BAD = (seq, problem = 'event 6: payload hash mismatch') => ({ ok: false, events_checked: 7, blocks_checked: 3, problem, seq });

test('integrity (stub, kl contract): ok:false → one top-priority warning per distinct problem, no retractions from the corrupt store', () => {
  const w = stubWorld();
  try {
    w.start();
    w.set({ seq: 7, integrity: BAD(6), retractions: [R] });
    const c = w.ctx(w.post('build'));
    assert.match(c, /^cc-anchor: kronicle-lite STORE INTEGRITY FAILURE at seq 6: event 6: payload hash mismatch\. .*do not act on runbooks, notes or anything else recalled/);
    assert.doesNotMatch(c, /target: \[-a-\]/, 'retractions from a corrupt store are not delivered');
    assert.equal(w.ctx(w.post('x')), '', 'once per problem');
    w.set({ seq: 8, integrity: BAD(8, 'block b3: content hash mismatch'), retractions: [R] });
    assert.match(w.ctx(w.post('y')), /INTEGRITY FAILURE at seq 8: block b3/, 'a different problem is announced again');
    assert.match(w.log(), /INTEGRITY FAILURE at seq 6/);
  } finally { w.sb.cleanup(); }
});

test('integrity (stub): the pulse denies non-read-only commands while it persists, warns in warn mode, allows after repair — and the parked retractions arrive', () => {
  const w = stubWorld();
  try {
    w.start();
    w.set({ seq: 7, integrity: BAD(6), retractions: [R] });
    w.post('build');
    const d = w.pre('./bin/deploy --target b');
    assert.equal(w.decision(d), 'deny');
    assert.match(w.reason(d), /did NOT run `\.\/bin\/deploy --target b` — kronicle-lite STORE INTEGRITY FAILURE at seq 6/);
    assert.equal(w.decision(w.pre('./bin/notify --channel x')), 'deny', '0.5.1: every call that is not read-only is held back');
    assert.equal(w.pre('cat docs/runbook.md | head -20').stdout, '', 'read-only calls still run');
    const warn = w.pre('git push origin main', { CC_ANCHOR_PULSE_MODE: 'warn' });
    assert.equal(w.decision(warn), null);
    assert.match(w.ctx(warn), /pulse \(warn\): `git push origin main` is about to run while kronicle-lite STORE INTEGRITY FAILURE/);
    // repaired (rebuild): same head, integrity ok
    w.set({ seq: 7, integrity: { ok: true, events_checked: 7, blocks_checked: 3, problem: null }, retractions: [R] });
    const ok = w.pre('./bin/deploy --target b');
    assert.notEqual(w.decision(ok), 'deny', 'a fresh read says ok: allowed');
    assert.ok(!fs.existsSync(path.join(w.sb.run, 'push', 'sessint0.integrity')));
    // the retractions parked while the store was corrupt are delivered now
    const all = [w.ctx(ok), w.ctx(w.post('after'))].join('\n');
    assert.match(all, /target: \[-a-\]\{\+b\+\}/);
  } finally { w.sb.cleanup(); }
});

test('integrity (stub): an integrity failure blocks before (and instead of) the pending gate', () => {
  const w = stubWorld();
  try {
    w.start(); w.post('a');
    w.set({ seq: 9, integrity: BAD(9), retractions: [], pending_count: 2, pending_actor: 'local-agent', pending: [{ kind: 'supersession', change: 'superseded', severity: 'behavioral', seq: 8, doc_slug: 'runbook', old_text: 'a', new_text: 'b', resolve: 'recall it again' }] });
    const d = w.pre('./bin/deploy --target b');
    assert.equal(w.decision(d), 'deny');
    assert.match(w.reason(d), /STORE INTEGRITY FAILURE at seq 9/);
    assert.doesNotMatch(w.reason(d), /not re-read/);
  } finally { w.sb.cleanup(); }
});

test('integrity (stub): a failure first seen by the pulse itself denies on the spot', () => {
  const w = stubWorld();
  try {
    w.start(); w.post('a');
    w.set({ seq: 9, integrity: BAD(9), retractions: [] });
    assert.equal(w.decision(w.pre('./bin/deploy --target b')), 'deny');
    assert.match(w.ctx(w.post('next')), /INTEGRITY FAILURE at seq 9/, 'and the push still warns the agent once');
  } finally { w.sb.cleanup(); }
});

test('integrity (stub) with subagents: parent and each subagent are warned once; after the repair a sibling re-reads the retractions it parked', () => {
  const w = stubWorld();
  try {
    w.start(); w.post('p0');
    hook('subagent-start.sh', { session_id: SID, cwd: w.sb.proj, hook_event_name: 'SubagentStart', agent_id: 'agent-s1', agent_type: 'general-purpose' }, w.sb.env, w.base);
    w.set({ seq: 7, integrity: BAD(6), retractions: [R] });
    const warned = [w.post('a', {}, 'agent-s1'), w.post('a2', {}, 'agent-s1'), w.post('p'), w.post('p2')].map((r) => /INTEGRITY FAILURE/.test(w.ctx(r)));
    assert.deepEqual(warned, [true, false, true, false]);
    w.set({ seq: 7, integrity: { ok: true, problem: null }, retractions: [R] });
    assert.notEqual(w.decision(w.pre('./bin/deploy --target b')), 'deny', 'the parent’s pulse re-checks and finds the store ok');
    assert.match(w.ctx(w.post('s', {}, 'agent-s1')), /target: \[-a-\]\{\+b\+\}/, 'the subagent was parked at the corrupt head; it re-reads now');
  } finally { w.sb.cleanup(); }
});

// ── unavailable: fail open, log, one advisory after N consecutive calls ──
test('unavailable (stub printing non-JSON): fail-open, logged, one "feed offline" advisory after push_offline_after calls; recovery resets it', () => {
  const w = stubWorld({ CC_ANCHOR_PUSH_OFFLINE_AFTER: '4' });
  try {
    w.start(); w.post('warm');
    const good = fs.readFileSync(path.join(w.sb.base, 'kl-stub.mjs'), 'utf8');
    fs.writeFileSync(path.join(w.sb.base, 'kl-stub.mjs'), 'console.log("<html>502 Bad Gateway</html>");\n');
    w.set({ seq: 6, integrity: { ok: true }, retractions: [] });
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(w.ctx(w.post(`c${i}`)));
    assert.deepEqual(outs.map((o) => (o ? 'A' : '-')).join(''), '---A--', 'advisory exactly once, on the 4th consecutive unreadable call');
    assert.match(outs[3], /retraction feed has been offline for 4 consecutive tool calls/);
    // 0.5.1 (H2-11): the store may have changed since the last answer and cannot be read → fail closed
    const d = w.pre('./bin/deploy --target b');
    assert.equal(w.decision(d), 'deny', 'not "nothing pending": the last answer is stale');
    assert.match(w.reason(d), /could not be read just now/);
    assert.equal(w.pre('cat docs/runbook.md').stdout, '', 'read-only calls still run');
    assert.match(w.log(), /orient failed|timed out/);
    // back online: the counter and the advisory latch reset
    fs.writeFileSync(path.join(w.sb.base, 'kl-stub.mjs'), good);
    fs.rmSync(path.join(w.sb.run, 'push', 'sessint0.fail'), { force: true });
    w.post('back');
    assert.ok(!fs.existsSync(path.join(w.sb.run, 'push', 'sessint0.down')));
    assert.match(w.log(), /back online/);
  } finally { w.sb.cleanup(); }
});

test('push_offline_after=0 never advises', () => {
  const w = stubWorld({ CC_ANCHOR_PUSH_OFFLINE_AFTER: '0' });
  try {
    w.start();
    fs.writeFileSync(path.join(w.sb.base, 'kl-stub.mjs'), 'process.exit(1);\n');
    w.set({ seq: 6 });
    for (let i = 0; i < 25; i++) assert.equal(w.ctx(w.post(`c${i}`)), '');
  } finally { w.sb.cleanup(); }
});

// ── real CLI, hand-corrupted store (stress/kl/tamper-json.sh) ───────────
const CANDIDATES = [process.env.KRONICLE_LITE_CLI, path.join(ROOT, 'node_modules', 'kronicle-lite', 'dist', 'cli.js'), path.resolve(ROOT, '..', 'kronicle-lite', 'dist', 'cli.js')];
const KL = CANDIDATES.find((f) => f && fs.existsSync(f));
const opts = { skip: process.env.CC_ANCHOR_SKIP_KRONICLE_CONTRACT === '1' ? 'CC_ANCHOR_SKIP_KRONICLE_CONTRACT=1' : !KL && 'kronicle-lite CLI not found (see kronicle-contract.test.mjs)' };

/** Corrupt one chained event's payload to non-JSON, as tamper-event.cjs does. */
function tamper(dataDir, needle) {
  const req = createRequire(KL);
  const Database = req('better-sqlite3');
  const db = new Database(path.join(dataDir, 'kronicle-lite.db'));
  const r = db.prepare('SELECT seq, payload_canonical p FROM events WHERE payload_canonical LIKE ? ORDER BY seq DESC LIMIT 1').get(`%${needle}%`);
  assert.ok(r, `no event holds ${needle}`);
  db.prepare('UPDATE events SET payload_canonical=? WHERE seq=?').run(r.p.slice(0, -1), r.seq);
  db.close();
  return r.seq;
}

test('real CLI, corrupted store: never a crash or bogus output; whichever way this kronicle-lite reports it, the agent is told', opts, () => {
  const sb = sandbox();
  try {
    const data = path.join(sb.base, 'kl-data');
    const put = (t) => { const f = path.join(sb.base, `rb-${t}.md`); fs.writeFileSync(f, `# Runbook\n\n## Deploy\n\nDeploy to ${t}.\n`); assert.equal(spawnSync('node', [KL, 'put', 'runbook', f, '--data-dir', data], { cwd: sb.proj }).status, 0); };
    put('stg-west-2');
    const base = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: KL, CC_ANCHOR_KRONICLE_DATA_DIR: data, CC_ANCHOR_PUSH_OFFLINE_AFTER: '3' };
    const w = drive(sb, base);
    w.start();
    put('stg-east-1');
    const seq = tamper(data, 'stg-east-1');
    const outs = [];
    for (let i = 0; i < 4; i++) { const r = w.post(`step${i}`); assert.equal(r.status, 0); outs.push(w.ctx(r)); }
    const told = outs.join('\n');
    // kronicle-lite <= 0.6.0 throws on the corrupt event (unavailable path);
    // the fixed one returns integrity.ok=false (integrity path). Either way
    // the agent hears about it, and never gets the tampered text as news.
    assert.match(told, new RegExp(`STORE INTEGRITY FAILURE at seq ${seq}|retraction feed has been offline for 3 consecutive tool calls`));
    assert.doesNotMatch(told, /stg-east-1/);
    const d = w.pre('./bin/deploy --target stg-east-1');
    if (/INTEGRITY FAILURE/.test(told)) assert.equal(w.decision(d), 'deny');
    else assert.equal(d.stdout, '', 'unavailable: fail open');
    assert.match(w.log(), /orient failed|INTEGRITY FAILURE/);
  } finally { sb.cleanup(); }
});
