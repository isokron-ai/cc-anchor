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
  // A loaded runner can take seconds to start node + sqlite: don't let the
  // board call's 4 s default timeout decide the outcome.
  const base = { CC_ANCHOR_SEA_LITE_BIN: SEA_CLI, CC_ANCHOR_SEA: '1', CC_ANCHOR_KRONICLE: '0', CC_ANCHOR_SCOPE_TIMEOUT: '30', ...extra };
  let n = 0;
  /** One Bash tool call: PreToolUse (pulse.sh stamps it), `work` runs, PostToolUse checks. */
  const bash = (sid, work, { tid = `toolu_${++n}`, envx = {} } = {}) => {
    const p = { session_id: sid, cwd: sb.proj, tool_name: 'Bash', tool_input: { command: 'some edit' }, tool_use_id: tid };
    hook('pulse.sh', { ...p, hook_event_name: 'PreToolUse' }, env, { ...base, ...envx });
    // Claude Code starts the shell well after the PreToolUse hook returns; keep
    // at least one kernel timestamp tick (~4 ms) between the stamp and the work,
    // or both get the same coarse timestamp and -newer/-cnewer (strict) misses it.
    sleep(0.02);
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
    assert.match(w.ctx(w.bash('sess-B', () => fs.rmSync(w.f('src', 'auth', 'new.ts')))), /- src\/auth\/ \(entries added, removed or renamed\) — held by claude#sessA/);
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): git-ignored output inside a claim (build logs) is not reported', opts, () => {
  const w = world();
  try {
    assert.equal(w.ctx(w.bash('sess-B', () => fs.writeFileSync(w.f('src', 'auth', 'build.log'), 'x\n'))), '');
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): costs — no process without a foreign claim; one find per call with one; sea-lite only to refresh the cache', opts, () => {
  const w = world();
  try {
    const calls = path.join(w.sb.base, 'calls');
    const shim = path.join(w.sb.base, 'sea-shim');
    fs.writeFileSync(shim, `#!/usr/bin/env bash\necho "sea:$1" >> ${JSON.stringify(calls)}\nexec node ${JSON.stringify(SEA_CLI)} "$@"\n`, { mode: 0o755 });
    const dir = path.join(w.sb.base, 'shims');
    fs.mkdirSync(dir);
    for (const tool of ['git', 'find']) {
      const real = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env bash\necho ${tool} >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
    }
    const envx = { CC_ANCHOR_SEA_LITE_BIN: shim, CC_ANCHOR_HEARTBEAT: '0', PATH: `${dir}:${process.env.PATH}` };
    const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
    const reset = () => fs.rmSync(calls, { force: true });
    w.bash('sess-A', () => {}, { envx });
    assert.ok(count().includes('sea:board'), 'the first call fills the claim cache');
    reset();
    for (let i = 0; i < 3; i++) w.bash('sess-A', () => {}, { envx });
    assert.deepEqual(count(), [], 'the only live claim is this session’s own: no process at all');
    for (let i = 0; i < 3; i++) assert.equal(w.ctx(w.bash('sess-B', () => {}, { envx })), '');
    assert.deepEqual(count(), ['find', 'find', 'find'], 'a foreign claim: one find per Bash call, no sea-lite, no git');
    reset();
    assert.match(w.ctx(w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'y\n'), { envx })), /login\.ts/);
    assert.deepEqual(count(), ['find', 'git'], 'a hit adds one git status (ignored-file filter)');
    reset();
    // A sea_* tool result drops the cache: the next Bash call refreshes it.
    hook('post-tool-use.sh', { session_id: 'sess-B', cwd: w.sb.proj, hook_event_name: 'PostToolUse', tool_name: 'mcp__sea-lite__sea_release', tool_input: { ticket_id: 'zzzzzzzz' }, tool_response: { content: [{ type: 'text', text: '{"released":[]}' }] } }, w.env, { ...w.base, ...envx });
    w.bash('sess-B', () => {}, { envx });
    assert.equal(count().filter((x) => x === 'sea:board').length, 1);
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): mtime-preserving writes count (cp -p, touch -r back-dating) — change time is checked too', opts, () => {
  const w = world();
  try {
    const old = w.f('old.ts');
    fs.writeFileSync(old, 'old\n');
    const past = new Date(Date.now() - 86400e3);
    fs.utimesSync(old, past, past);
    sleep(1.1);
    assert.match(w.ctx(w.bash('sess-B', () => spawnSync('cp', ['-p', old, w.f('src', 'auth', 'login.ts')]))), /login\.ts — held by claude#sessA/, 'cp -p');
    sleep(1.1);
    assert.match(w.ctx(w.bash('sess-B', () => { fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'evil\n'); fs.utimesSync(w.f('src', 'auth', 'login.ts'), past, past); })), /login\.ts/, 'write, then back-date the mtime');
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): overlapping Bash calls of one session keep separate stamps', opts, () => {
  const w = world();
  try {
    w.bash('sess-B', () => {}); // warm
    const p = (tid) => ({ session_id: 'sess-B', cwd: w.sb.proj, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: tid });
    hook('pulse.sh', { ...p('toolu_p1'), hook_event_name: 'PreToolUse' }, w.env, w.base);
    hook('pulse.sh', { ...p('toolu_p2'), hook_event_name: 'PreToolUse' }, w.env, w.base);
    fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'p\n');
    const r1 = hook('post-tool-use.sh', { ...p('toolu_p1'), hook_event_name: 'PostToolUse', tool_response: {} }, w.env, w.base);
    assert.match(w.ctx(r1), /login\.ts/);
    assert.ok(!fs.existsSync(path.join(w.sb.run, 'bashguard', 'sessB.pre.toolu_p1')), 'a used stamp is removed');
    assert.ok(fs.existsSync(path.join(w.sb.run, 'bashguard', 'sessB.pre.toolu_p2')), 'the other call’s stamp is untouched');
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): a claim made by another session after the cache was filled is seen at once (store changed → refresh), not after the TTL', opts, () => {
  const w = world({ env: { CC_ANCHOR_BASH_GUARD_TTL: '3600' } });
  try {
    w.bash('sess-B', () => {}); // cache filled: only src/auth is claimed
    sleep(1.1);
    const env = { ...w.env };
    const sea = (args) => spawnSync('node', [SEA_CLI, ...args], { encoding: 'utf8', cwd: w.sb.proj, env });
    const id2 = JSON.parse(sea(['create', 'Billing', '--triaged', '--json']).stdout).ticket.id;
    assert.equal(sea(['claim', id2, '--paths', 'src/billing', '--lease', '900', '--actor', 'other', '--session', 'sess-C']).status, 0);
    assert.match(w.ctx(w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'billing', 'pay.ts'), 'z\n'))), /src\/billing\/pay\.ts — held by other#sessC/);
  } finally { w.sb.cleanup(); }
});

test('bash guard (real CLI): a claimed directory with thousands of entries is scanned completely', opts, () => {
  const w = world();
  try {
    const gen = w.f('src', 'auth', 'gen');
    fs.mkdirSync(gen);
    for (let i = 0; i < 4500; i++) fs.writeFileSync(path.join(gen, `f${i}.ts`), '');
    fs.writeFileSync(w.f('src', 'auth', 'zz-last.ts'), '');
    sleep(1.1);
    assert.match(w.ctx(w.bash('sess-B', () => fs.appendFileSync(w.f('src', 'auth', 'zz-last.ts'), 'z\n'))), /zz-last\.ts/);
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

test('bash guard (real CLI): a project root reached through a symlink (macOS /var → /private/var) is reported in the hook’s own spelling', opts, () => {
  const w = world();
  try {
    const link = path.join(w.sb.base, 'via-link');
    fs.symlinkSync(w.sb.proj, link);
    const env = { ...w.env, CLAUDE_PROJECT_DIR: link };
    const p = { session_id: 'sess-B', cwd: link, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'toolu_link1' };
    hook('pulse.sh', { ...p, hook_event_name: 'PreToolUse' }, env, w.base);
    sleep(0.02);
    fs.appendFileSync(w.f('src', 'auth', 'login.ts'), 'l\n');
    const r = hook('post-tool-use.sh', { ...p, hook_event_name: 'PostToolUse', tool_response: {} }, env, w.base);
    assert.match(w.ctx(r), /^- src\/auth\/login\.ts — held by claude#sessA, ticket [0-9a-f]{8} "Add rate limiting to login" \(locks src\/auth;/m, `stdout=${r.stdout} stderr=${r.stderr} log=${fs.existsSync(path.join(w.sb.run, 'log')) ? fs.readFileSync(path.join(w.sb.run, 'log'), 'utf8') : ''}`);
  } finally { w.sb.cleanup(); }
});
