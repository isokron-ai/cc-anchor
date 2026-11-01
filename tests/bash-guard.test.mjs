// 0.5.0 Bash claimed-path guard, against the REAL sea-lite CLI (>= 0.4.0):
// after a Bash call, a changed path inside a live claim held by ANOTHER
// session is named right away (holder, ticket, expiry); the holder's own
// session, unclaimed paths, unchanged trees and git-ignored output are quiet.
// Same CLI discovery as sea-contract.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, sandbox, hook } from './helpers.mjs';

const CANDIDATES = [process.env.SEA_LITE_CLI, path.join(ROOT, 'node_modules', 'sea-lite', 'dist', 'cli.js'), path.resolve(ROOT, '..', 'sea-lite', 'dist', 'cli.js')];
const SEA_CLI = CANDIDATES.find((f) => f && fs.existsSync(f));
const SKIP = process.env.CC_ANCHOR_SKIP_SEA_CONTRACT === '1' ? 'CC_ANCHOR_SKIP_SEA_CONTRACT=1' : false;
const opts = { skip: SKIP || (!SEA_CLI && 'sea-lite CLI not found (see sea-contract.test.mjs)') };
const sleep = (s) => spawnSync('sleep', [String(s)]);

/** A real git repo with src/auth claimed by claude in session sess-A (lease 900 s). */
function world({ env: extra = {} } = {}) {
  const sb = sandbox({ git: false });
  const git = (...a) => spawnSync('git', ['-C', sb.proj, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  git('init', '-q');
  fs.mkdirSync(path.join(sb.proj, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(sb.proj, 'src', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(sb.proj, 'src', 'auth', 'login.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(sb.proj, 'src', 'billing', 'pay.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(sb.proj, '.gitignore'), '*.log\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  const data = path.join(sb.base, 'sea-data');
  const env = { ...sb.env, KRONICLE_LITE_DATA_DIR: data };
  const sea = (args) => spawnSync('node', [SEA_CLI, ...args], { encoding: 'utf8', cwd: sb.proj, env });
  const id = JSON.parse(sea(['create', 'Add rate limiting to login', '--triaged', '--json']).stdout).ticket.id;
  const c = sea(['claim', id, '--paths', 'src/auth', '--lease', '900', '--actor', 'claude', '--session', 'sess-A']);
  assert.equal(c.status, 0, c.stderr);
  const base = { CC_ANCHOR_SEA_LITE_BIN: SEA_CLI, CC_ANCHOR_SEA: '1', CC_ANCHOR_KRONICLE: '0', ...extra };
  let n = 0;
  /** One Bash tool call: PreToolUse (pulse.sh stamps it), `work` runs, PostToolUse checks. */
  const bash = (sid, work, { tid = `toolu_${++n}`, envx = {} } = {}) => {
    const p = { session_id: sid, cwd: sb.proj, tool_name: 'Bash', tool_input: { command: 'some edit' }, tool_use_id: tid };
    hook('pulse.sh', { ...p, hook_event_name: 'PreToolUse' }, env, { ...base, ...envx });
    work?.();
    return hook('post-tool-use.sh', { ...p, hook_event_name: 'PostToolUse', tool_response: { stdout: '' } }, env, { ...base, ...envx });
  };
  const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
  const f = (...p) => path.join(sb.proj, ...p);
  sleep(1.1); // mtimes of the setup are older than any stamp, even at 1 s resolution (bash 3.2)
  return { sb, id, bash, ctx, f, base, env, git };
}

test('bash guard (real CLI): a Bash edit inside another session’s claim is named at once — path, holder, ticket, title, expiry', opts, () => {
  const w = world();
  try {
    const r = w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'auth', 'login.ts'), '// sed -i\n'));
    assert.equal(r.status, 0);
    const c = w.ctx(r);
    assert.match(c, /^cc-anchor bash guard: that Bash call changed 1 path\(s\) inside live sea-lite claims held by OTHER sessions:/);
    assert.match(c, /- src\/auth\/login\.ts — held by claude#sessA, ticket [0-9a-f]{8} "Add rate limiting to login" \(locks src\/auth; expires \d{4}-\d\d-\d\dT/);
    assert.ok(c.includes(w.id.slice(0, 8)));
    assert.match(c, /Undo your change/);
    const log = fs.readFileSync(path.join(w.sb.run, 'log'), 'utf8');
    assert.equal(log.match(/bash_guard: 1 path/g)?.length, 1, 'one log line');
    assert.equal(w.ctx(w.bash('sess-B', () => {})), '', 'reported once: the next call changed nothing');
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): new and deleted files count; the holder’s own session and unclaimed paths are quiet', opts, () => {
  const w = world();
  try {
    assert.equal(w.ctx(w.bash('sess-A', () => fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'x\n'))), '', 'the holder session edits its own claim');
    assert.equal(w.ctx(w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'billing', 'pay.ts'), 'x\n'))), '', 'outside the claim');
    assert.match(w.ctx(w.bash('sess-B', () => fs.writeFileSync(w.f('src', 'auth', 'new.ts'), 'n\n'))), /- src\/auth\/new\.ts — held by claude#sessA/);
    sleep(1.1);
    assert.match(w.ctx(w.bash('sess-B', () => fs.rmSync(w.f('src', 'auth', 'new.ts')))), /- src\/auth\/ \(entries removed or renamed\) — held by claude#sessA/);
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): git-ignored output inside a claim (build logs) is not reported', opts, () => {
  const w = world();
  try {
    assert.equal(w.ctx(w.bash('sess-B', () => fs.writeFileSync(w.f('src', 'auth', 'build.log'), 'x\n'))), '');
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): no process when nothing changed — the claim list is cached; sea_* results drop the cache', opts, () => {
  const w = world();
  try {
    const shim = path.join(w.sb.base, 'sea-shim');
    const calls = path.join(w.sb.base, 'calls');
    fs.writeFileSync(shim, `#!/usr/bin/env bash\necho "$1" >> ${JSON.stringify(calls)}\nexec node ${JSON.stringify(SEA_CLI)} "$@"\n`, { mode: 0o755 });
    const gitShimDir = path.join(w.sb.base, 'gitshim');
    fs.mkdirSync(gitShimDir);
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(gitShimDir, 'git'), `#!/usr/bin/env bash\necho git >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const envx = { CC_ANCHOR_SEA_LITE_BIN: shim, CC_ANCHOR_HEARTBEAT: '0', PATH: `${gitShimDir}:${process.env.PATH}` };
    const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
    w.bash('sess-B', () => {}, { envx });
    assert.deepEqual(count(), ['board'], 'first call fills the claim cache');
    for (let i = 0; i < 4; i++) assert.equal(w.ctx(w.bash('sess-B', () => {}, { envx })), '');
    assert.deepEqual(count(), ['board'], 'nothing changed: no sea-lite, no git');
    assert.match(w.ctx(w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'y\n'), { envx })), /login\.ts/);
    assert.deepEqual(count(), ['board', 'git'], 'a change in a claimed path costs one git status (ignored-file filter)');
    // A sea_* tool result drops the cache: the next Bash call refreshes it.
    hook('post-tool-use.sh', { session_id: 'sess-B', cwd: w.sb.proj, hook_event_name: 'PostToolUse', tool_name: 'mcp__sea-lite__sea_release', tool_input: { ticket_id: 'zzzzzzzz' }, tool_response: { content: [{ type: 'text', text: '{"released":[]}' }] } }, w.env, { ...w.base, ...envx });
    w.bash('sess-B', () => {}, { envx });
    assert.equal(count().filter((x) => x === 'board').length, 2);
  } finally { w.sb.cleanup(); }
});

test('bash guard: a PostToolUse whose tool_use_id was not stamped (PreToolUse did not run) reports nothing', opts, () => {
  const w = world();
  try {
    w.bash('sess-B', () => {}, { tid: 'toolu_A' });
    fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'z\n');
    const r = hook('post-tool-use.sh', { session_id: 'sess-B', cwd: w.sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'toolu_OTHER', tool_response: {} }, w.env, w.base);
    assert.equal(w.ctx(r), '');
  } finally { w.sb.cleanup(); }
});

test('bash guard fails open: a broken sea-lite prints nothing, logs once; bash_guard=0 and no sea-lite at all are inert', opts, () => {
  const w = world();
  try {
    const bad = path.join(w.sb.base, 'bad-sea');
    fs.writeFileSync(bad, '#!/usr/bin/env bash\necho boom >&2; exit 3\n', { mode: 0o755 });
    const r = w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'q\n'), { envx: { CC_ANCHOR_SEA_LITE_BIN: bad } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(path.join(w.sb.run, 'log'), 'utf8'), /bash_guard: sea-lite board failed/);
    assert.equal(w.ctx(w.bash('sess-C', () => fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'r\n'), { envx: { CC_ANCHOR_BASH_GUARD: '0' } })), '');
  } finally { w.sb.cleanup(); }
  const sb = sandbox();
  try {
    const p = { session_id: 's1', cwd: sb.proj, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1' };
    hook('pulse.sh', { ...p, hook_event_name: 'PreToolUse' }, sb.env);
    assert.equal(hook('post-tool-use.sh', { ...p, hook_event_name: 'PostToolUse', tool_response: {} }, sb.env).stdout, '');
    assert.ok(fs.existsSync(path.join(sb.run, 'bashguard', 's1.off')), 'no claims, no sea-lite: latched off for the session');
  } finally { sb.cleanup(); }
});
