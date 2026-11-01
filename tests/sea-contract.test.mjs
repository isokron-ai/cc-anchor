// Contract tests against the REAL sea-lite CLI (>= 0.4.0), not a fake.
//
// cc-anchor 0.2.0's scope guard was tested against a fake sea-lite that
// spoke a contract the real CLI never had (wrong field names, no --json,
// absolute paths it rejected), so the guard failed open on every real
// conflict. These tests drive scripts/pre-tool-use.sh, post-tool-use.sh and
// the Cursor adapter against the actual CLI so the two cannot drift again.
//
// The CLI is found at $SEA_LITE_CLI, ./node_modules/sea-lite/dist/cli.js, or
// a sibling checkout ../sea-lite/dist/cli.js (built). If none is present the
// tests FAIL with instructions; CC_ANCHOR_SKIP_SEA_CONTRACT=1 skips them
// explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, SCRIPTS, sandbox, hook, fixture } from './helpers.mjs';

const CANDIDATES = [process.env.SEA_LITE_CLI, path.join(ROOT, 'node_modules', 'sea-lite', 'dist', 'cli.js'), path.resolve(ROOT, '..', 'sea-lite', 'dist', 'cli.js')];
const SEA_CLI = CANDIDATES.find((f) => f && fs.existsSync(f));
const SKIP = process.env.CC_ANCHOR_SKIP_SEA_CONTRACT === '1' ? 'CC_ANCHOR_SKIP_SEA_CONTRACT=1' : false;

function seaVersion() {
  if (!SEA_CLI) return null;
  const r = spawnSync('node', [SEA_CLI, '--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

test('the real sea-lite CLI (>= 0.4.0) is available for the contract tests', { skip: SKIP }, () => {
  assert.ok(SEA_CLI, `sea-lite CLI not found; tried ${CANDIDATES.filter(Boolean).join(', ')}. Run \`npm i --no-save sea-lite@^0.4.0\`, set SEA_LITE_CLI, or CC_ANCHOR_SKIP_SEA_CONTRACT=1 to skip.`);
  const v = seaVersion();
  assert.ok(v && /^(0\.(4|[5-9])|[1-9])/.test(v), `sea-lite ${v} is older than 0.4.0 (no scope-check JSON contract)`);
});

const opts = { skip: SKIP || (!SEA_CLI && 'sea-lite CLI not found (see the first test)') };

/** A sandbox with a sea-lite data dir and a claim held by claude in session sess-A on src/auth. */
function seeded({ lease = 900 } = {}) {
  const sb = sandbox();
  const data = path.join(sb.base, 'sea-data');
  const env = { ...sb.env, KRONICLE_LITE_DATA_DIR: data };
  const sea = (args, cwd = sb.proj) => {
    const r = spawnSync('node', [SEA_CLI, ...args], { encoding: 'utf8', cwd, env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const created = sea(['create', 'Add rate limiting to login', '--triaged', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const id = JSON.parse(created.stdout).ticket.id;
  const claimed = sea(['claim', id, '--paths', 'src/auth', '--lease', String(lease), '--actor', 'claude', '--session', 'sess-A']);
  assert.equal(claimed.status, 0, claimed.stderr);
  const guard = { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: SEA_CLI, KRONICLE_LITE_DATA_DIR: data };
  const edit = (sid, file, extra = {}) => hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { session_id: sid, cwd: sb.proj, tool_input: { file_path: file } }), env, { ...guard, ...extra });
  const expiry = () => JSON.parse(sea(['board', '--json']).stdout).tickets.find((t) => t.id === id).claim?.expires_at;
  return { sb, data, env, sea, id, guard, edit, expiry };
}

test('scope guard (real CLI): another session of the SAME actor is denied with holder, ticket, title and expiry; the holder session is allowed', opts, () => {
  const { sb, id, edit } = seeded();
  try {
    const deny = edit('sess-B', `${sb.proj}/src/auth/login.ts`);
    assert.equal(deny.status, 0);
    assert.ok(deny.json, `expected a deny, got stdout=${deny.stdout} log=${fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : ''}`);
    assert.equal(deny.json.hookSpecificOutput.permissionDecision, 'deny');
    const reason = deny.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /src\/auth\/login\.ts/);
    assert.match(reason, /claude#sessA/);
    assert.match(reason, new RegExp(id.slice(0, 8)));
    assert.match(reason, /Add rate limiting to login/);
    assert.match(reason, /locks src\/auth/);
    assert.match(reason, /expires \d{4}-\d\d-\d\dT/);
    const allow = edit('sess-A', `${sb.proj}/src/auth/login.ts`);
    assert.equal(allow.stdout, '', 'the holder session edits its own claim');
    assert.equal(edit('sess-B', `${sb.proj}/src/billing/x.ts`).stdout, '', 'outside the claim');
  } finally { sb.cleanup(); }
});

test('scope guard (real CLI): passes the absolute path, --json and --session; outside-repo files and unrelated repos are allowed without a failure log', opts, () => {
  const { sb, edit } = seeded();
  try {
    const calls = path.join(sb.base, 'calls.log');
    const shim = path.join(sb.base, 'sea-shim');
    fs.writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\nexec node "${SEA_CLI}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    const r = edit('sess-B', `${sb.proj}/src/auth/a.ts`, { CC_ANCHOR_SEA_LITE_BIN: shim });
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny');
    const line = fs.readFileSync(calls, 'utf8').trim();
    assert.match(line, /^scope-check --json --session sess-B /);
    assert.ok(line.endsWith(` ${sb.proj}/src/auth/a.ts`), line);
    // A file outside any repository: sea-lite says outside_repo (exit 2) and the guard allows it quietly.
    fs.writeFileSync(path.join(sb.base, 'notes.txt'), '');
    assert.equal(edit('sess-B', path.join(sb.base, 'notes.txt')).stdout, '');
    // Another repository: its paths never collide with this one's claims.
    const other = path.join(sb.base, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    assert.equal(edit('sess-B', `${other}/src/auth/login.ts`).stdout, '');
    const log = fs.existsSync(path.join(sb.run, 'log')) ? fs.readFileSync(path.join(sb.run, 'log'), 'utf8') : '';
    assert.doesNotMatch(log, /failing open/, 'no fail-open on the happy paths');
  } finally { sb.cleanup(); }
});

test('scope guard: verdicts are cached per session, so one session’s "ok" never answers for another', opts, () => {
  const { sb, edit } = seeded();
  try {
    const f = `${sb.proj}/src/auth/session.ts`;
    assert.equal(edit('sess-A', f).stdout, '', 'holder: ok (cached)');
    assert.equal(edit('sess-B', f).json?.hookSpecificOutput?.permissionDecision, 'deny', 'other session: not served from the holder’s cache');
    assert.equal(edit('sess-A', f).stdout, '', 'and the deny is not served back to the holder');
    const cache = JSON.parse(fs.readFileSync(path.join(sb.run, 'scope-cache.json'), 'utf8'));
    assert.deepEqual(Object.keys(cache).sort(), [`sess-A|${f}`, `sess-B|${f}`]);
  } finally { sb.cleanup(); }
});

test('Cursor adapter (real CLI): preToolUse deny maps to {permission: deny}; sea_session config names the Cursor server’s session', opts, () => {
  const { sb, guard } = seeded();
  try {
    const env = { ...sb.env, KRONICLE_LITE_DATA_DIR: guard.KRONICLE_LITE_DATA_DIR }; delete env.CLAUDE_PROJECT_DIR;
    const run = (extra) => {
      const r = spawnSync('bash', [path.join(ROOT, 'cursor', 'adapter.sh'), 'preToolUse'], {
        input: JSON.stringify(fixture('cursor-pretooluse.json', { workspace_roots: [sb.proj], cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/auth/a.ts`, content: '' } })),
        encoding: 'utf8',
        env: { ...env, ...guard, ...extra },
      });
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    };
    const deny = run({ CC_ANCHOR_SEA_SESSION: 'cursor-window-2' });
    assert.equal(deny?.permission, 'deny');
    assert.match(deny.agent_message, /claude#sessA/);
    fs.rmSync(path.join(sb.run, 'scope-cache.json'), { force: true });
    assert.equal(run({ CC_ANCHOR_SEA_SESSION: 'sess-A' }), null, 'the holder’s own session is allowed');
  } finally { sb.cleanup(); }
});

test('PostToolUse heartbeat (real CLI): renews this session’s claims, rate-limited per session; heartbeat=0 disables', opts, () => {
  const { sb, env, guard, expiry } = seeded({ lease: 120 });
  try {
    const before = expiry();
    const post = (sid, extra = {}) => hook('post-tool-use.sh', { session_id: sid, cwd: sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: {} }, env, { CC_ANCHOR_SEA_LITE_BIN: SEA_CLI, KRONICLE_LITE_DATA_DIR: guard.KRONICLE_LITE_DATA_DIR, CC_ANCHOR_SYNC: '1', CC_ANCHOR_HEARTBEAT: '1', ...extra });
    spawnSync('sleep', ['1.1']);
    assert.equal(post('sess-B').status, 0);
    assert.equal(expiry(), before, 'another session’s heartbeat does not renew sess-A’s claim');
    assert.equal(post('sess-A').stdout, '', 'PostToolUse prints nothing');
    const after = expiry();
    assert.ok(Date.parse(after) > Date.parse(before), `renewed: ${before} -> ${after}`);
    spawnSync('sleep', ['1.1']);
    post('sess-A');
    assert.equal(expiry(), after, 'second call within heartbeat_interval: no spawn');
    fs.rmSync(path.join(sb.run, 'hb-sessA'), { force: true });
    spawnSync('sleep', ['1.1']);
    post('sess-A', { CC_ANCHOR_HEARTBEAT: '0' });
    assert.equal(expiry(), after, 'heartbeat=0 disables');
    const t0 = process.hrtime.bigint();
    post('sess-A');
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000, 'bounded');
  } finally { sb.cleanup(); }
});

test('scope guard: a sea-lite older than 0.4.0 (no JSON contract) fails open and says why, once', opts, () => {
  const sb = sandbox();
  try {
    const old = path.join(sb.base, 'old-sea');
    fs.writeFileSync(old, `#!/usr/bin/env bash\necho 'invalid_input: scope path "/x" must be repo-relative, not absolute' >&2\nexit 1\n`);
    fs.chmodSync(old, 0o755);
    const r = hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/a.ts` } }), sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: old });
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /older than 0\.4\.0/);
  } finally { sb.cleanup(); }
});

test('Stop claim guard only lists the claims of the stopping session (no cross-session token leak)', () => {
  const sb = sandbox();
  try {
    const claim = (sid, ticket, token) =>
      hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { session_id: sid, cwd: sb.proj, tool_input: { ticket_ids: [ticket] }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ claims: [{ ticket_id: ticket, claim_token: token, expires_at: '2099-01-01T00:00:00Z' }] }) }] } }), sb.env);
    claim('sess-A', 'tkt_A', 'tok_A_secret');
    claim('sess-B', 'tkt_B', 'tok_B_secret');
    const stop = (sid) => hook('stop.sh', { session_id: sid, cwd: sb.proj, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '' }, sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    const b = stop('sess-B');
    assert.equal(b.json?.decision, 'block');
    assert.match(b.json.reason, /tkt_B/);
    assert.doesNotMatch(b.json.reason, /tkt_A|tok_A_secret/);
    const c = stop('sess-C');
    assert.equal(c.stdout, '', 'a session holding nothing is not blocked by others’ claims');
  } finally { sb.cleanup(); }
});

test('pre-tool-use.sh no longer mentions the fake contract fields', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'pre-tool-use.sh'), 'utf8');
  assert.doesNotMatch(src, /\{holder,ticket,paths,expires\}/);
  assert.match(src, /sea-lite\.scope-check\//);
});
