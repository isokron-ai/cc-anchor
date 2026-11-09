// Hook I/O against payloads copied from the Claude Code hooks reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseCard, orientMcpHook, worktreePackHooks, CONFIG_KEYS } from '../scripts/anchor.mjs';
import { sandbox, fixture, hook, cli, postTool, isoMinutesAgo, SCRIPTS, ROOT } from './helpers.mjs';

// ───────────── PostToolUse ─────────────

test('PostToolUse (docs Write payload): breadcrumb appended, card rendered, no stdout', () => {
  const sb = sandbox();
  try {
    const r = hook('post-tool-use.sh', fixture('posttooluse-write.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const lines = sb.trailLines();
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]);
    assert.equal(e.tool, 'Write');
    assert.equal(e.target, '/path/to/file.txt');
    assert.equal(e.session, 'abc123');
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const c = parseCard(sb.readCard());
    assert.deepEqual(c.trail[0], { ts: e.ts, tool: 'Write', target: '/path/to/file.txt' });
  } finally { sb.cleanup(); }
});

test('PostToolUse: card keeps only the last 5 breadcrumbs, newest first; trail log keeps all', () => {
  const sb = sandbox();
  try {
    for (let i = 1; i <= 7; i++) postTool(sb.env, 'Bash', { command: `echo ${i}` });
    assert.equal(sb.trailLines().length, 7);
    const c = parseCard(sb.readCard());
    assert.equal(c.trail.length, 5);
    assert.deepEqual(c.trail.map((t) => t.target), ['echo 7', 'echo 6', 'echo 5', 'echo 4', 'echo 3']);
  } finally { sb.cleanup(); }
});

test('PostToolUse: CC_ANCHOR_TRAIL_N changes how many breadcrumbs the card shows', () => {
  const sb = sandbox();
  try {
    for (let i = 1; i <= 4; i++) hook('post-tool-use.sh', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `f${i}` } }, sb.env, { CC_ANCHOR_TRAIL_N: '2' });
    assert.equal(parseCard(sb.readCard()).trail.length, 2);
  } finally { sb.cleanup(); }
});

test('PostToolUse: paths under the project root are relativised; other targets kept', () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Edit', { file_path: path.join(sb.proj, 'src', 'a.ts') });
    postTool(sb.env, 'Grep', { pattern: 'TODO', path: '/elsewhere' });
    postTool(sb.env, 'WebFetch', { url: 'https://example.com/x' });
    postTool(sb.env, 'Skill', { skill: 'anchor' });
    const t = parseCard(sb.readCard()).trail.map((x) => `${x.tool} ${x.target}`);
    assert.deepEqual(t, ['Skill anchor', 'WebFetch https://example.com/x', 'Grep /elsewhere', 'Edit src/a.ts']);
  } finally { sb.cleanup(); }
});

test('PostToolUse: long/multiline Bash commands are clipped to one 96-char line', () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Bash', { command: 'x'.repeat(50) + '\n' + 'y'.repeat(100) });
    const target = parseCard(sb.readCard()).trail[0].target;
    assert.ok(target.length <= 96);
    assert.ok(!target.includes('\n'));
  } finally { sb.cleanup(); }
});

test('PostToolUse: trail rotation trims the log to 200 lines once it passes 400 (at Stop/PreCompact)', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(sb.run, { recursive: true });
    const lines = [];
    for (let i = 0; i < 405; i++) lines.push(JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'T', target: String(i), session: 's' }));
    fs.writeFileSync(sb.trail, lines.join('\n') + '\n');
    postTool(sb.env, 'Read', { file_path: 'x' });
    assert.equal(sb.trailLines().length, 406, 'hot path never rewrites the log');
    const r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(sb.trailLines().length, 200);
    assert.equal(JSON.parse(sb.trailLines().at(-1)).target, 'x', 'newest entries survive rotation');
  } finally { sb.cleanup(); }
});

test('PostToolUse: concurrent invocations never corrupt the card', async () => {
  const sb = sandbox();
  try {
    const { spawn } = await import('node:child_process');
    const procs = [];
    for (let i = 0; i < 12; i++) {
      const p = spawn('bash', [path.join(SCRIPTS, 'post-tool-use.sh')], { env: sb.env });
      p.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `f${i}` }, session_id: 's' }));
      procs.push(new Promise((res) => p.on('close', res)));
    }
    await Promise.all(procs);
    const c = parseCard(sb.readCard());
    assert.equal(c.hasMarker, true);
    assert.ok(c.trail.length >= 1 && c.trail.length <= 5);
    assert.equal(sb.trailLines().length, 12);
  } finally { sb.cleanup(); }
});

test('PostToolUse: empty stdin, non-JSON stdin and missing jq all fail open (exit 0, no output)', () => {
  const sb = sandbox();
  try {
    assert.deepEqual([hook('post-tool-use.sh', '', sb.env).status, hook('post-tool-use.sh', 'not json', sb.env).stdout], [0, '']);
    const r = hook('post-tool-use.sh', fixture('posttooluse-write.json'), sb.env, { PATH: '/nonexistent' }, '/bin/bash');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(sb.card));
  } finally { sb.cleanup(); }
});

// Wall-clock budgets depend on the runner's load (2-core boxes, macOS CI):
// opt-in with CC_ANCHOR_PERF_TESTS=1 (CI runs them in a separate,
// non-blocking step); behaviour is covered by the deterministic tests.
const PERF = process.env.CC_ANCHOR_PERF_TESTS === '1' ? {} : { skip: 'wall-clock budget: set CC_ANCHOR_PERF_TESTS=1' };

test('PostToolUse: cold hook run takes less than 50 ms wall (budget 20 ms on a dev box)', PERF, () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Read', { file_path: 'warm' });
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const t0 = process.hrtime.bigint();
      postTool(sb.env, 'Read', { file_path: `f${i}` });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    assert.ok(median < 50, `median ${median.toFixed(1)} ms (samples: ${samples.map((s) => s.toFixed(0)).join(',')})`);
  } finally { sb.cleanup(); }
});

// ───────────── cursor capture + detection ─────────────

test('PostToolUse on mcp__*__get_system_state captures the compact cursor into <run>/cursor and the card', () => {
  const sb = sandbox();
  try {
    const r = hook('post-tool-use.sh', fixture('posttooluse-get-system-state.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(sb.cursorFile, 'utf8').trim(), 'sxt1c.42.Ab12Cd34');
    assert.equal(parseCard(sb.readCard()).cursor, 'sxt1c.42.Ab12Cd34');
    assert.equal(parseCard(sb.readCard()).trail[0].tool, 'mcp__kronicle-lite__get_system_state');
  } finally { sb.cleanup(); }
});

test('cursor detection: .sextant-cursor JSON, .kronicle-cursor text, .cc-anchor-cursor precedence, invalid ignored', () => {
  const sb = sandbox();
  try {
    assert.match(cli(['cursor'], sb.env).stdout, /cursor: none found/);
    fs.writeFileSync(path.join(sb.proj, '.kronicle-cursor'), 'sxt1c.7.kkkkkkkk\n');
    assert.match(cli(['cursor'], sb.env).stdout, /cursor: sxt1c\.7\.kkkkkkkk/);
    fs.writeFileSync(path.join(sb.proj, '.sextant-cursor'), JSON.stringify({ schema_version: 1, cursor_token: 'sxt1.eyJ4IjoxfQ.c2ln', last_oriented_at: 'x' }));
    assert.match(cli(['cursor'], sb.env).stdout, /cursor: sxt1\.eyJ4IjoxfQ\.c2ln/);
    fs.writeFileSync(path.join(sb.proj, '.cc-anchor-cursor'), 'sxt1c.99.aaaaaaaa');
    assert.match(cli(['cursor'], sb.env).stdout, /cursor: sxt1c\.99\.aaaaaaaa/);
    fs.writeFileSync(path.join(sb.proj, '.cc-anchor-cursor'), 'garbage token');
    assert.match(cli(['cursor'], sb.env).stdout, /cursor: sxt1\.eyJ4IjoxfQ\.c2ln/, 'invalid file skipped, next candidate used');
    // the shell side agrees (render puts the same cursor on the card)
    postTool(sb.env, 'Read', { file_path: 'x' });
    assert.equal(parseCard(sb.readCard()).cursor, 'sxt1.eyJ4IjoxfQ.c2ln');
  } finally { sb.cleanup(); }
});

test('kronicle detection: .mcp.json, ~/.claude.json per-project, enabledPlugins, env override', () => {
  const sb = sandbox();
  try {
    const k = () => JSON.parse(cli(['cursor', '--json'], sb.env).stdout).kronicle_configured;
    assert.equal(k(), false);
    fs.writeFileSync(path.join(sb.proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'kronicle-lite': { command: 'npx', args: ['-y', 'kronicle-lite', 'serve'] } } }));
    assert.equal(k(), true);
    fs.rmSync(path.join(sb.proj, '.mcp.json'));
    fs.writeFileSync(path.join(sb.home, '.claude.json'), JSON.stringify({ projects: { [sb.proj]: { mcpServers: { notes: { command: 'npx', args: ['kronicle-lite', 'serve'] } } } } }));
    assert.equal(k(), true);
    fs.rmSync(path.join(sb.home, '.claude.json'));
    fs.mkdirSync(path.join(sb.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(sb.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kronicle-lite@isokron-plugins': true } }));
    assert.equal(k(), true);
    fs.writeFileSync(path.join(sb.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kronicle-lite@isokron-plugins': false } }));
    assert.equal(k(), false);
    assert.equal(JSON.parse(cli(['cursor', '--json'], sb.env, { CC_ANCHOR_KRONICLE: '1' }).stdout).kronicle_configured, true);
  } finally { sb.cleanup(); }
});

// ───────────── PreCompact ─────────────

test('PreCompact (docs payload): stamps compacted_at, writes the card, prints nothing, exits 0', () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Read', { file_path: 'before' });
    const r = hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'PreCompact has no context channel; we never emit a decision');
    const st = sb.readState();
    assert.match(st.compacted_at, /^\d{4}-/);
    assert.equal(st.compact_trigger, 'manual');
    assert.equal(st.compact_count, '1');
    assert.equal(parseCard(sb.readCard()).compacted, st.compacted_at);
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj, trigger: 'auto' }), sb.env);
    assert.equal(sb.readState().compact_count, '2');
    assert.equal(sb.readState().compact_trigger, 'auto');
  } finally { sb.cleanup(); }
});

test('PreCompact with no card yet still produces a card to inject', () => {
  const sb = sandbox();
  try {
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj }), sb.env);
    assert.ok(fs.existsSync(sb.card));
    assert.match(sb.readCard(), /no tool calls recorded yet/);
  } finally { sb.cleanup(); }
});

// ───────────── SessionStart ─────────────

test('SessionStart(compact): JSON envelope with the verbatim card under the mandated header', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'Finish the migration'], sb.env);
    cli(['add-invariant', 'never drop the users table'], sb.env);
    postTool(sb.env, 'Edit', { file_path: `${sb.proj}/db.sql` });
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj }), sb.env);
    const r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.ok(r.json, `stdout must be one JSON object, got: ${r.stdout.slice(0, 80)}`);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith('ANCHOR — verbatim, read before anything else\n'));
    assert.ok(ctx.includes(sb.readCard().trimEnd()), 'card embedded verbatim');
    assert.match(ctx, /RETRACTED, not historical/);
    assert.match(ctx, /never drop the users table/);
    assert.match(ctx, /Edit db\.sql/);
    assert.doesNotMatch(ctx, /since_cursor/, 'no kronicle configured => no cursor instruction');
    assert.ok(ctx.length < 10000, 'under the additionalContext cap');
  } finally { sb.cleanup(); }
});

test('SessionStart(compact) with kronicle-lite + cursor appends the since_cursor instruction', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'kronicle-lite': { command: 'npx', args: ['-y', 'kronicle-lite', 'serve'] } } }));
    fs.writeFileSync(path.join(sb.proj, '.cc-anchor-cursor'), 'sxt1c.42.abcd1234\n');
    const r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /call get_system_state with since_cursor=sxt1c\.42\.abcd1234 before material work/);
    assert.match(ctx, /^Cursor: sxt1c\.42\.abcd1234$/m);
  } finally { sb.cleanup(); }
});

test('SessionStart(compact) with kronicle-lite but no cursor asks for a cold get_system_state', () => {
  const sb = sandbox();
  try {
    const r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_KRONICLE: '1' });
    assert.match(r.json.hookSpecificOutput.additionalContext, /no cursor is on disk: call get_system_state \(cold\)/);
  } finally { sb.cleanup(); }
});

test('SessionStart(compact) with a cursor but no kronicle-lite omits the instruction (card still shows Cursor)', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.proj, '.cc-anchor-cursor'), 'sxt1c.1.ffffffff\n');
    const r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_KRONICLE: '0' });
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /get_system_state/);
    assert.match(ctx, /^Cursor: sxt1c\.1\.ffffffff$/m);
  } finally { sb.cleanup(); }
});

test('SessionStart(resume, docs payload) injects the card with a session-start header; startup with no card is silent', () => {
  const sb = sandbox();
  try {
    const silent = hook('session-start.sh', fixture('sessionstart-resume.json', { cwd: sb.proj }), sb.env);
    assert.equal(silent.status, 0);
    assert.equal(silent.stdout, '');
    cli(['set', 'goal', 'resume me'], sb.env);
    const r = hook('session-start.sh', fixture('sessionstart-resume.json', { cwd: sb.proj }), sb.env);
    assert.ok(r.json);
    assert.ok(r.json.hookSpecificOutput.additionalContext.startsWith('ANCHOR — session start (resume)'));
    assert.match(r.json.hookSpecificOutput.additionalContext, /Goal: resume me/);
  } finally { sb.cleanup(); }
});

test('SessionStart(startup) stays silent when InstructionsLoaded only rendered the empty template card ("Project: (unset)")', () => {
  const sb = sandbox();
  try {
    hook('instructions-loaded.sh', fixture('instructionsloaded-session-start.json', { cwd: sb.proj, file_path: `${sb.proj}/CLAUDE.md` }), sb.env);
    assert.match(sb.readCard(), /^Project: \(unset/m, 'the template card exists on disk');
    for (const src of ['startup', 'resume', 'clear']) {
      const r = hook('session-start.sh', fixture('sessionstart-resume.json', { cwd: sb.proj, source: src }), sb.env);
      assert.equal(r.stdout, '', `${src}: no empty card injected`);
    }
    cli(['add-invariant', 'never push to main'], sb.env);
    const r = hook('session-start.sh', fixture('sessionstart-resume.json', { cwd: sb.proj, source: 'startup' }), sb.env);
    assert.match(r.json?.hookSpecificOutput?.additionalContext || '', /never push to main/, 'one real entry is enough to inject');
    const c = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env);
    assert.match(c.json?.hookSpecificOutput?.additionalContext || '', /^ANCHOR — verbatim/, 'compact always injects');
  } finally { sb.cleanup(); }
});

test('SessionStart(compact) with no card at all explains how to create one', () => {
  const sb = sandbox();
  try {
    const r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_DIR: '/proc/nonexistent/readonly' });
    assert.equal(r.status, 0);
    assert.ok(r.json);
    assert.match(r.json.hookSpecificOutput.additionalContext, /no anchor card on disk/);
  } finally { sb.cleanup(); }
});

// ───────────── UserPromptSubmit ─────────────

test('UserPromptSubmit (docs payload): ordinary prompts pass through with no output', () => {
  const sb = sandbox();
  try {
    const r = hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { sb.cleanup(); }
});

test('UserPromptSubmit: the bare word "anchor" re-injects the card as additionalContext', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'manual re-ground'], sb.env);
    for (const prompt of ['anchor', '  Anchor ', 'ANCHOR']) {
      const r = hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj, prompt }), sb.env);
      assert.ok(r.json, `prompt ${JSON.stringify(prompt)}`);
      assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(r.json.hookSpecificOutput.additionalContext, /Goal: manual re-ground/);
    }
    assert.equal(hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj, prompt: 'anchor the boat' }), sb.env).stdout, '');
  } finally { sb.cleanup(); }
});

// ───────────── Stop ─────────────

test('Stop (docs payload): silent when the anchor is fresh; one systemMessage when drift passes the threshold', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'fresh'], sb.env);
    let r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    sb.writeState({ ...sb.readState(), refreshed_at: isoMinutesAgo(120) });
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env);
    assert.ok(r.json, r.stdout);
    assert.match(r.json.systemMessage, /120 min old/);
    assert.equal(r.json.decision, undefined, 'never blocks the stop');
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.stdout, '', 'rate-limited to once per 30 min');
    sb.writeState({ ...sb.readState(), warned_at: isoMinutesAgo(31) });
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj, stop_hook_active: true }), sb.env);
    assert.equal(r.stdout, '', 'stop_hook_active => stay quiet');
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_STOP_WARN: '0' });
    assert.equal(r.stdout, '', 'opt-out honoured');
  } finally { sb.cleanup(); }
});

// ───────────── Statusline ─────────────

test('statusline (docs payload shape): ⚓ goal · N since compact · drift', () => {
  const sb = sandbox();
  try {
    const payload = fixture('statusline.json', { cwd: sb.proj, workspace: { current_dir: sb.proj, project_dir: sb.proj, added_dirs: [] } });
    let r = hook('statusline.sh', payload, sb.env, { CC_ANCHOR_COLOR: '0' });
    assert.equal(r.stdout.trim(), '⚓ no anchor · /cc-anchor:anchor set goal "…"');
    cli(['set', 'goal', 'Ship cc-anchor v0.1.0 to the marketplace tonight without fail'], sb.env);
    for (let i = 0; i < 3; i++) postTool(sb.env, 'Read', { file_path: `f${i}` });
    r = hook('statusline.sh', payload, sb.env, { CC_ANCHOR_COLOR: '0' });
    assert.equal(r.stdout.trim(), '⚓ Ship cc-anchor v0.1.0 to the marketplac… · 3 since compact · drift: 0m');
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj }), sb.env);
    r = hook('statusline.sh', payload, sb.env, { CC_ANCHOR_COLOR: '0' });
    assert.match(r.stdout, /· 0 since compact ·/);
  } finally { sb.cleanup(); }
});

test('statusline: drift segment warns past the threshold (yellow) and 2x (red)', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'g'], sb.env);
    const payload = fixture('statusline.json', { workspace: { project_dir: sb.proj } });
    sb.writeState({ ...sb.readState(), refreshed_at: isoMinutesAgo(50) });
    let r = hook('statusline.sh', payload, sb.env);
    assert.match(r.stdout, /\x1b\[33mdrift: 50m ⚠\x1b\[0m/);
    sb.writeState({ ...sb.readState(), refreshed_at: isoMinutesAgo(100) });
    r = hook('statusline.sh', payload, sb.env);
    assert.match(r.stdout, /\x1b\[31mdrift: 100m ⚠\x1b\[0m/);
    r = hook('statusline.sh', payload, sb.env, { CC_ANCHOR_DRIFT_WARN_MIN: '200', CC_ANCHOR_COLOR: '0' });
    assert.match(r.stdout.trim(), /drift: 100m$/);
  } finally { sb.cleanup(); }
});

test('statusline install: refuses to overwrite a foreign statusLine (exit 3), --append wraps, --force replaces, uninstall restores', () => {
  const sb = sandbox();
  try {
    const settings = path.join(sb.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
    let r = cli(['statusline', 'install'], sb.env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /already configured/);
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, 'echo mine');
    r = cli(['statusline', 'install', '--append'], sb.env);
    assert.equal(r.status, 0, r.stderr);
    const wrapper = JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command;
    assert.match(wrapper, /statusline-wrapper\.sh$/);
    assert.match(fs.readFileSync(wrapper, 'utf8'), /echo mine/);
    r = cli(['statusline', 'uninstall'], sb.env);
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, 'echo mine');
    r = cli(['statusline', 'install', '--force'], sb.env);
    assert.equal(r.status, 0);
    const cmd = JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command;
    assert.match(cmd, /\/\.claude\/cc-anchor\/statusline\.sh$/);
    assert.ok(fs.existsSync(path.join(sb.home, '.claude', 'cc-anchor', 'lib.sh')), 'lib.sh copied next to it');
    r = cli(['statusline', 'install'], sb.env);
    assert.equal(r.status, 0, 're-install over our own entry is fine');
    assert.deepEqual(JSON.parse(cli(['statusline', 'snippet'], sb.env).stdout).statusLine.type, 'command');
  } finally { sb.cleanup(); }
});

// ───────────── plugin wiring ─────────────

test('hooks.json references only scripts that exist, in exec form, with timeouts', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['InstructionsLoaded', 'PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'UserPromptSubmit']);
  for (const [ev, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      assert.equal(h.type, 'command', ev);
      assert.equal(h.command, 'bash', ev);
      assert.ok(Array.isArray(h.args) && h.args.length === 1, ev);
      const rel = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${ev}: ${rel} exists`);
      assert.ok(h.timeout > 0 && h.timeout <= 15, ev);
    }
  }
  assert.equal(hooks.PreCompact[0].matcher, 'manual|auto');
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact|fork');
  assert.equal(hooks.PostToolUse[0].matcher, '*');
  assert.equal(hooks.InstructionsLoaded[0].matcher, 'session_start|compact|nested_traversal|path_glob_match|include', 'a plugin hook never sees session_start (plugins register after the eager load; proven on 2.1.316) so the lazy reasons carry the stamp');
  assert.equal(hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  for (const ev of ['WorktreeCreate', 'WorktreeRemove']) assert.ok(!(ev in hooks), `${ev} must stay opt-in: a WorktreeCreate hook replaces git worktree creation entirely (hooks reference)`);
  for (const [, groups] of Object.entries(hooks)) for (const g of groups) for (const h of g.hooks) assert.notEqual(h.type, 'mcp_tool', 'plugin hooks.json carries no mcp_tool hook: its server name is per-user and a missing server is a hook error for everyone else');
});

test('doctor runs and reports the resolved store', () => {
  const sb = sandbox();
  try {
    const r = cli(['doctor', '--json'], sb.env);
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.match(d.store, /^project → /);
    assert.equal(d.jq, 'ok');
    assert.match(d['hooks.json events'], /PreCompact/);
  } finally { sb.cleanup(); }
});

// ═══════════════════════════ 0.2.0 lifecycle hooks pack ═══════════════════════════

import os from 'node:os';

const FAKE_SEA = path.join(ROOT, 'tests', 'fixtures', 'fake-sea-lite');
const seaEnv = (sb, extra = {}) => ({ ...extra, CC_ANCHOR_SEA: '1' });
const claimsOf = (sb) => JSON.parse(fs.readFileSync(path.join(sb.run, 'claims.json'), 'utf8')).claims;
const pendingOf = (sb) => (fs.existsSync(path.join(sb.run, 'pending-release.jsonl')) ? fs.readFileSync(path.join(sb.run, 'pending-release.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

/** A fake `sea-lite` / `kronicle-lite` CLI in the sandbox. body = bash. */
function fakeCli(sb, name, body) {
  const bin = path.join(sb.base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const f = path.join(bin, name);
  fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

// ───────────── claim tracking (PostToolUse → claims.json) ─────────────

test('claims: sea_claim result (docs-shaped MCP tool_response) is tracked per agent; expired entries dropped', () => {
  const sb = sandbox();
  try {
    const r = hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj, agent_id: 'def456' }), sb.env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'claim tracking never prints');
    const c = claimsOf(sb);
    assert.deepEqual(Object.keys(c), ['tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2']);
    const e = c.tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2;
    assert.equal(e.claim_token, 'clm_9f8e7d6c5b4a3928');
    assert.equal(e.agent, 'def456');
    assert.equal(e.session, 'abc123');
    assert.equal(e.via, 'sea_claim');
    assert.equal(e.expires, '2099-01-01T00:10:00Z');
    assert.equal(e.cwd, sb.proj);
    // an expired lease is not live
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj, tool_input: { ticket_ids: ['tkt_old'] }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ claims: [{ ticket_id: 'tkt_old', claim_token: 'x', expires_at: '2000-01-01T00:00:00Z' }] }) }] } }), sb.env);
    assert.ok(!('tkt_old' in claimsOf(sb)), 'expired claim not kept');
    assert.ok('tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2' in claimsOf(sb));
  } finally { sb.cleanup(); }
});

test('claims: sea_next (plugin-scoped tool name) adds; sea_transition to a terminal state and sea_release remove; prefix ids honoured', () => {
  const sb = sandbox();
  try {
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj }), sb.env);
    hook('post-tool-use.sh', fixture('posttooluse-sea-next.json', { cwd: sb.proj }), sb.env);
    assert.deepEqual(Object.keys(claimsOf(sb)).sort(), ['tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2', 'tkt_01J0NEXT00000000000000000A']);
    assert.equal(claimsOf(sb).tkt_01J0NEXT00000000000000000A.via, 'sea_next');
    // non-terminal transition keeps the claim
    hook('post-tool-use.sh', fixture('posttooluse-sea-transition.json', { cwd: sb.proj, tool_input: { ticket_id: 'tkt_01J0NEXT', claim_token: 'x', to: 'parked' } }), sb.env);
    assert.ok('tkt_01J0NEXT00000000000000000A' in claimsOf(sb));
    // terminal transition by 8+ char prefix releases
    hook('post-tool-use.sh', fixture('posttooluse-sea-transition.json', { cwd: sb.proj, tool_input: { ticket_id: 'tkt_01J0NEXT', claim_token: 'x', to: 'resolved' } }), sb.env);
    assert.ok(!('tkt_01J0NEXT00000000000000000A' in claimsOf(sb)));
    hook('post-tool-use.sh', fixture('posttooluse-sea-release.json', { cwd: sb.proj }), sb.env);
    assert.deepEqual(claimsOf(sb), {});
  } finally { sb.cleanup(); }
});

test('claims: an error result (isError / {error}) changes nothing; non-sea tools never touch claims.json', () => {
  const sb = sandbox();
  try {
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj, tool_response: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'already_claimed', message: 'held by bob' }) }] } }), sb.env);
    assert.ok(!fs.existsSync(path.join(sb.run, 'claims.json')) || Object.keys(claimsOf(sb)).length === 0);
    const before = fs.statSync(path.join(sb.run, 'claims.json')).mtimeMs;
    postTool(sb.env, 'Read', { file_path: 'x' });
    postTool(sb.env, 'mcp__sea-lite__sea_get', { id: 'tkt_1' });
    assert.equal(fs.statSync(path.join(sb.run, 'claims.json')).mtimeMs, before, 'non-claim tools never rewrite claims.json');
    assert.deepEqual(claimsOf(sb), {});
  } finally { sb.cleanup(); }
});

test('claims: PostToolUse hot path stays under budget with the claims branch present (non-sea tool)', PERF, () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Read', { file_path: 'warm' });
    const samples = [];
    for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); postTool(sb.env, 'Read', { file_path: `f${i}` }); samples.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    samples.sort((a, b) => a - b);
    assert.ok(samples[3] < 50, `median ${samples[3].toFixed(1)} ms`);
  } finally { sb.cleanup(); }
});

// ───────────── Stop: claim guard (block once) + session doc ─────────────

test('Stop claim guard: off by default; on => blocks ONCE per claim set with sea_release instructions; stop_hook_active short-circuits', () => {
  const sb = sandbox();
  try {
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj }), sb.env);
    let r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.stdout, '', 'claim_guard is opt-in');
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.ok(r.json, r.stdout);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /^release or hand off your sea-lite claim first/);
    assert.match(r.json.reason, /sea_release \{"ticket_id": "tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2", "claim_token": "clm_9f8e7d6c5b4a3928"/);
    // once: same claim set => no second block
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.equal(r.stdout, '', 'blocked once per claim set');
    // stop_hook_active => never blocks even for a new set
    hook('post-tool-use.sh', fixture('posttooluse-sea-next.json', { cwd: sb.proj }), sb.env);
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj, stop_hook_active: true }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.equal(r.stdout, '');
    // a new claim set re-arms the guard
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.equal(r.json?.decision, 'block');
    assert.match(r.json.reason, /2 live claim/);
    // releasing everything => silent
    hook('post-tool-use.sh', fixture('posttooluse-sea-release.json', { cwd: sb.proj }), sb.env);
    hook('post-tool-use.sh', fixture('posttooluse-sea-transition.json', { cwd: sb.proj }), sb.env);
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.equal(r.stdout, '');
  } finally { sb.cleanup(); }
});

test('Stop claim guard reads the switch from .claude/cc-anchor.json (project) and config.json (user); env wins', () => {
  const sb = sandbox();
  try {
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj }), sb.env);
    fs.writeFileSync(path.join(sb.proj, '.claude', 'cc-anchor.json'), JSON.stringify({ claim_guard: true }));
    let r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.json?.decision, 'block', 'project config honoured');
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj, session_id: 'other' }), sb.env, { CC_ANCHOR_CLAIM_GUARD: 'false' });
    assert.equal(r.stdout, '', 'env override wins over the file');
    fs.rmSync(path.join(sb.proj, '.claude', 'cc-anchor.json'));
    fs.mkdirSync(path.join(sb.home, '.claude', 'cc-anchor'), { recursive: true });
    fs.writeFileSync(path.join(sb.home, '.claude', 'cc-anchor', 'config.json'), JSON.stringify({ claim_guard: 'on' }));
    // The guard only looks at the stopping session's claims (0.3.0), so give session "third" one of its own.
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj, session_id: 'third', tool_input: { ticket_ids: ['tkt_third'] }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ claims: [{ ticket_id: 'tkt_third', claim_token: 't3', expires_at: '2099-01-01T00:00:00Z' }] }) }] } }), sb.env);
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj, session_id: 'third' }), sb.env);
    assert.equal(r.json?.decision, 'block', 'user config honoured');
    // the CLI agrees on the effective value
    assert.equal(JSON.parse(cli(['config', '--json'], sb.env).stdout).claim_guard, 'on');
    cli(['config', 'set', 'claim_guard', 'false'], sb.env);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.proj, '.claude', 'cc-anchor.json'), 'utf8')).claim_guard, false);
    assert.equal(JSON.parse(cli(['config', '--json'], sb.env).stdout).claim_guard, false, 'project file beats user file');
  } finally { sb.cleanup(); }
});

test('Stop session_doc: puts session-<date>-<sid8> (card + last_assistant_message) through the kronicle-lite CLI, skips unchanged messages, fails open without the CLI', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'doc me'], sb.env);
    const seen = path.join(sb.base, 'put-calls.log');
    fakeCli(sb, 'kronicle-lite', `printf '%s\\n' "$*" >> "${seen}"; [[ "$1" == put ]] && cat "$3" >> "${seen}"; echo '{"revision":1}'`);
    const env = { CC_ANCHOR_SESSION_DOC: '1', CC_ANCHOR_SYNC: '1', CC_ANCHOR_KRONICLE_LITE_BIN: path.join(sb.base, 'bin', 'kronicle-lite'), CC_ANCHOR_KRONICLE_DATA_DIR: '/tmp/kl-data' };
    let r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'session doc never emits a decision by itself');
    const log = fs.readFileSync(seen, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    assert.match(log, new RegExp(`^put session-${today}-abc123 .*--title Session ${today} abc123 --actor cc-anchor --data-dir /tmp/kl-data$`, 'm'));
    assert.match(log, /Goal: doc me/);
    assert.match(log, /I've completed the refactoring/);
    assert.equal(sb.readState().session_doc_slug, `session-${today}-abc123`);
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(fs.readFileSync(seen, 'utf8').split('\nput ').length, 1, 'same message => no second put');
    hook('stop.sh', fixture('stop.json', { cwd: sb.proj, last_assistant_message: 'something new' }), sb.env, env);
    assert.match(fs.readFileSync(seen, 'utf8'), /something new/);
    // no CLI anywhere => exit 0, nothing printed, one log line
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj, last_assistant_message: 'third' }), sb.env, { CC_ANCHOR_SESSION_DOC: '1', CC_ANCHOR_SYNC: '1', PATH: '/usr/bin:/bin', HOME: sb.home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /kronicle-lite CLI not found/);
  } finally { sb.cleanup(); }
});

test('Stop: claim block wins over the drift nudge; drift nudge still works with the pack present', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'g'], sb.env);
    sb.writeState({ ...sb.readState(), refreshed_at: isoMinutesAgo(120) });
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj }), sb.env);
    let r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.equal(r.json.decision, 'block');
    assert.equal(r.json.systemMessage, undefined);
    r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.match(r.json.systemMessage, /120 min old/);
  } finally { sb.cleanup(); }
});

// ───────────── SubagentStop ─────────────

test('SubagentStop (docs payload): releases are arranged for the stopping agent_id only — block once with the tokens, pending-release.jsonl written, surfaced by SessionStart and `anchor`', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'g'], sb.env);
    // main agent holds one claim, subagent def456 holds another
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj }), sb.env);
    hook('post-tool-use.sh', fixture('posttooluse-sea-next.json', { cwd: sb.proj, agent_id: 'def456' }), sb.env);
    let r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj }), sb.env, seaEnv(sb));
    assert.ok(r.json, r.stdout);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /release your sea-lite claim\(s\) before finishing — you still hold 1/);
    assert.match(r.json.reason, /tkt_01J0NEXT00000000000000000A.*clm_next_1234567890abcdef/);
    assert.doesNotMatch(r.json.reason, /tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2/, "main agent's claim is not the subagent's problem");
    const pend = pendingOf(sb);
    assert.equal(pend.length, 1);
    assert.equal(pend[0].ticket_id, 'tkt_01J0NEXT00000000000000000A');
    assert.equal(pend[0].agent, 'def456');
    // once
    r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj }), sb.env, seaEnv(sb));
    assert.equal(r.stdout, '');
    r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj, stop_hook_active: true, agent_id: 'zzz' }), sb.env, seaEnv(sb));
    assert.equal(r.stdout, '', 'unknown agent / stop_hook_active => silent');
    assert.equal(pendingOf(sb).length, 1, 'dedup by ticket');
    // the parent sees it on the next orient
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj }), sb.env);
    r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Pending sea-lite releases[\s\S]*tkt_01J0NEXT00000000000000000A.*clm_next_1234567890abcdef/);
    r = hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj, prompt: 'anchor' }), sb.env);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Pending sea-lite releases/);
    // released (by anyone) => pending entry pruned, nothing surfaced
    hook('post-tool-use.sh', fixture('posttooluse-sea-transition.json', { cwd: sb.proj }), sb.env);
    r = hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env);
    assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /Pending sea-lite/);
    assert.ok(!fs.existsSync(path.join(sb.run, 'pending-release.jsonl')));
  } finally { sb.cleanup(); }
});

test('SubagentStop: auto mode is inert without sea-lite configured; CC_ANCHOR_SUBAGENT_RELEASE=0 disables; no agent_id => silent', () => {
  const sb = sandbox();
  try {
    hook('post-tool-use.sh', fixture('posttooluse-sea-next.json', { cwd: sb.proj, agent_id: 'def456' }), sb.env);
    let r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.stdout, '', 'no sea-lite detected => no block');
    r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_SEA: '1', CC_ANCHOR_SUBAGENT_RELEASE: '0' });
    assert.equal(r.stdout, '');
    r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj, agent_id: '' }), sb.env, { CC_ANCHOR_SEA: '1' });
    assert.equal(r.stdout, '');
    r = hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_SEA: '1' });
    assert.equal(r.json?.decision, 'block', 'sea-lite forced on => block');
  } finally { sb.cleanup(); }
});

// ───────────── PreToolUse scope guard ─────────────

test('PreToolUse scope guard (docs Edit payload): off by default (no output, no sea-lite spawn); on + conflict => deny in the current hookSpecificOutput shape; verdict cached per session and path; a sea_* result drops the cache', () => {
  // The conflict contract itself is pinned against the REAL sea-lite CLI in
  // tests/sea-contract.test.mjs. This stub answers in that contract's shape
  // only to exercise cc-anchor's switch, cache and invalidation.
  const sb = sandbox();
  try {
    const calls = path.join(sb.base, 'scope-calls.log');
    const conflict = JSON.stringify({ schema: 'sea-lite.scope-check/1', ok: false, conflicts: [{ ticket_id: 'tkt_01B0000000', title: 'B work', holder: 'agent-b', holder_session: null, holder_label: 'agent-b', held: ['src/**'], claim_expires_at: '2099-01-01T00:00:00Z', expires_in_seconds: 9 }] });
    const bin = fakeCli(sb, 'sea-lite', `echo "$*" >> "${calls}"; [[ "$1" == scope-check ]] || exit 2; if [[ "\${@: -1}" == *a.ts ]]; then echo '${conflict}'; exit 1; fi; exit 0`);
    const on = { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin };
    let r = hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/a.ts` } }), sb.env);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(calls), 'guard off => sea-lite never spawned');
    r = hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/a.ts` } }), sb.env, on);
    assert.ok(r.json, r.stdout);
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput']);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /agent-b on ticket tkt_01B0 \("B work"; locks src\/\*\*; expires 2099/);
    assert.equal(r.json.decision, undefined, 'top-level decision is deprecated for PreToolUse');
    assert.equal(fs.readFileSync(calls, 'utf8').trim(), `scope-check --json --session abc123 ${sb.proj}/src/a.ts`);
    r = hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/a.ts` } }), sb.env, on);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length, 1, 'second edit served from the cache');
    r = hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_name: 'Write', tool_input: { file_path: `${sb.proj}/src/b.ts`, content: '' } }), sb.env, on);
    assert.equal(r.stdout, '', 'no conflict => allow');
    // a sea_* result invalidates the cache
    hook('post-tool-use.sh', fixture('posttooluse-sea-release.json', { cwd: sb.proj }), sb.env);
    hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/a.ts` } }), sb.env, on);
    assert.equal(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length, 3, 're-checked after claims moved');
  } finally { sb.cleanup(); }
});

test('PreToolUse scope guard fails open: no binary, unsupported subcommand (exit 2), timeout — exit 0, never a deny, logged once, the agent told once (H2-22)', () => {
  const sb = sandbox();
  try {
    const p = fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/x.ts` } });
    let r = hook('pre-tool-use.sh', p, sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', PATH: '/usr/bin:/bin', HOME: sb.home });
    assert.equal(r.status, 0);
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, 'never a deny');
    assert.match(r.json?.hookSpecificOutput?.additionalContext ?? '', /sea-lite is not answering right now \(the sea-lite CLI was not found\)\. The claim guards are NOT checking/);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /sea-lite CLI not found; failing open/);
    const old = fakeCli(sb, 'sea-lite', 'echo "unknown command: $1" >&2; exit 2');
    fs.rmSync(path.join(sb.run, 'scope-cache.json'), { force: true });
    r = hook('pre-tool-use.sh', p, sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: old });
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /scope-check exited 2 \(unsupported subcommand/);
    const n = fs.readFileSync(path.join(sb.run, 'log'), 'utf8').split('\n').filter((l) => /unsupported/.test(l)).length;
    fs.rmSync(path.join(sb.run, 'scope-cache.json'), { force: true });
    hook('pre-tool-use.sh', p, sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: old });
    assert.equal(fs.readFileSync(path.join(sb.run, 'log'), 'utf8').split('\n').filter((l) => /unsupported/.test(l)).length, n, 'logged once');
    // The fake hangs 10 s; scope_timeout is 1 s. The bound is 5 s, not ~1 s:
    // a cold hook on a shared macOS runner spends well over a second in
    // bash/jq startup, and anything under the fake's 10 s proves the kill.
    // Run twice: timeout(1) when present, and the set -m watchdog fallback
    // that macOS (no timeout/gtimeout) actually uses.
    const slow = fakeCli(sb, 'sea-lite', 'sleep 10; exit 1');
    for (const fallback of ['0', '1']) {
      fs.rmSync(path.join(sb.run, 'scope-cache.json'), { force: true });
      const t0 = Date.now();
      r = hook('pre-tool-use.sh', p, sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: slow, CC_ANCHOR_SCOPE_TIMEOUT: '1', CC_ANCHOR_TEST_NO_TIMEOUT_BIN: fallback });
      const ms = Date.now() - t0;
      assert.equal(r.status, 0); assert.equal(r.stdout, '', 'advised once per outage already');
      assert.ok(ms < 5000, `bounded by scope_timeout (fallback=${fallback}): ${ms} ms`);
    }
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /exited 124 \(crash or timeout\)/);
  } finally { sb.cleanup(); }
});

test('PreToolUse scope guard never caches a failure, and a sea-lite store change drops cached verdicts (H2-21, H2-23)', () => {
  const sb = sandbox();
  try {
    const calls = path.join(sb.base, 'calls');
    const mode = path.join(sb.base, 'mode');
    const data = path.join(sb.base, 'sea');
    fs.mkdirSync(data);
    const conflict = JSON.stringify({ schema: 'sea-lite.scope-check/1', ok: false, conflicts: [{ ticket_id: 'tkt_X', title: 'X', holder: 'b', holder_label: 'b', held: ['src/**'], claim_expires_at: '2099' }] });
    // mode file: ok | conflict | slow | exit2
    const bin = fakeCli(sb, 'sea-lite', `echo x >> "${calls}"; m=$(cat "${mode}"); case $m in conflict) echo '${conflict}'; exit 1;; slow) sleep 10;; exit2) echo '{"schema":"sea-lite.scope-check/1","error":"invalid_input","details":{"reason":"climbs"}}'; exit 2;; esac; exit 0`);
    const on = { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin, CC_ANCHOR_SEA_DATA_DIR: data, CC_ANCHOR_SCOPE_TIMEOUT: '1' };
    const p = fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/login.ts` } });
    const n = () => fs.readFileSync(calls, 'utf8').trim().split('\n').length;
    const db = path.join(data, 'kronicle-lite.db');
    fs.writeFileSync(db, ''); const old = new Date(Date.now() - 60000); fs.utimesSync(db, old, old);
    fs.writeFileSync(mode, 'ok');
    assert.equal(hook('pre-tool-use.sh', p, sb.env, on).stdout, '');
    hook('pre-tool-use.sh', p, sb.env, on);
    assert.equal(n(), 1, 'ok is cached while the store is unchanged');
    fs.writeFileSync(mode, 'conflict');
    const later = new Date(Date.now() + 5000); fs.utimesSync(db, later, later); // someone claimed: the store changed
    assert.equal(hook('pre-tool-use.sh', p, sb.env, on).json?.hookSpecificOutput?.permissionDecision, 'deny', 'H2-21a: a claim made after the cached ok is seen');
    fs.utimesSync(db, old, old); fs.rmSync(path.join(sb.run, 'scope-cache.json'));
    for (const m of ['slow', 'exit2']) {
      fs.writeFileSync(mode, m);
      assert.notEqual(hook('pre-tool-use.sh', p, sb.env, on).json?.hookSpecificOutput?.permissionDecision, 'deny', `${m}: fail open`);
      fs.writeFileSync(mode, 'conflict');
      assert.equal(hook('pre-tool-use.sh', p, sb.env, on).json?.hookSpecificOutput?.permissionDecision, 'deny', `H2-21b/H2-23: ${m} was not cached as ok`);
      fs.rmSync(path.join(sb.run, 'scope-cache.json'));
    }
  } finally { sb.cleanup(); }
});

test('PreToolUse scope guard: cached verdict path is fast (< 30 ms median) and the off path is faster', PERF, () => {
  const sb = sandbox();
  try {
    const bin = fakeCli(sb, 'sea-lite', 'exit 0');
    const on = { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin };
    const p = fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/hot.ts` } });
    hook('pre-tool-use.sh', p, sb.env, on);
    const time = (env) => { const s = []; for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); hook('pre-tool-use.sh', p, sb.env, env); s.push(Number(process.hrtime.bigint() - t0) / 1e6); } s.sort((a, b) => a - b); return s[3]; };
    const cached = time(on); const off = time({});
    assert.ok(cached < 30 * 2, `cached median ${cached.toFixed(1)} ms (budget 30 ms on a dev box, 2x slack for CI)`);
    assert.ok(off < cached, `off ${off.toFixed(1)} ms should be below cached ${cached.toFixed(1)} ms`);
  } finally { sb.cleanup(); }
});

// ───────────── Task mirror ─────────────

test('TaskCreated/TaskCompleted mirror (docs payloads): opt-in; idempotent create with key cc-task:<id>; completion resolves the ticket; replayed create does not duplicate', () => {
  const sb = sandbox();
  try {
    const data = path.join(sb.base, 'sea-data');
    const env = { CC_ANCHOR_TASK_MIRROR: '1', CC_ANCHOR_SEA_MODULE: FAKE_SEA, CC_ANCHOR_SEA_DATA_DIR: data };
    let r = hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(data, 'fake-sea.json')), 'off by default');
    r = hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    let db = JSON.parse(fs.readFileSync(path.join(data, 'fake-sea.json'), 'utf8'));
    const [id, t] = Object.entries(db.tickets)[0];
    assert.equal(t.title, 'Implement user authentication');
    assert.equal(t.body, 'Add login and signup endpoints');
    assert.equal(t.status, 'triaged');
    assert.deepEqual(t.tags, ['cc-task', 'cc-task:task-001']);
    assert.equal(db.idem['cc-task:task-001'], id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.run, 'tasks.json'), 'utf8'))['task-001'], id);
    hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj }), sb.env, env);
    db = JSON.parse(fs.readFileSync(path.join(data, 'fake-sea.json'), 'utf8'));
    assert.equal(Object.keys(db.tickets).length, 1, 'idempotent');
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
    db = JSON.parse(fs.readFileSync(path.join(data, 'fake-sea.json'), 'utf8'));
    assert.equal(db.tickets[id].status, 'resolved');
    assert.equal(db.tickets[id].claim, null, 'terminal transition released the mirror claim');
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0, 'completing twice is a no-op');
    // without tasks.json the tag lookup still finds the ticket
    fs.rmSync(path.join(sb.run, 'tasks.json'));
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /already resolved/);
  } finally { sb.cleanup(); }
});

test('TaskCompleted gate: exit 2 + stderr while a mirrored ticket has an open predecessor; task_mirror_gate=0 skips; mirror failures never block', () => {
  const sb = sandbox();
  try {
    const data = path.join(sb.base, 'sea-data');
    const env = { CC_ANCHOR_TASK_MIRROR: '1', CC_ANCHOR_SEA_MODULE: FAKE_SEA, CC_ANCHOR_SEA_DATA_DIR: data };
    hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj, task_id: 'task-A', task_subject: 'schema' }), sb.env, env);
    hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj, task_id: 'task-B', task_subject: 'endpoints' }), sb.env, env);
    const dbf = path.join(data, 'fake-sea.json');
    const db = JSON.parse(fs.readFileSync(dbf, 'utf8'));
    const [a, b] = Object.keys(db.tickets);
    db.links.push({ from_id: b, to_id: a, link_type: 'depends_on' });
    fs.writeFileSync(dbf, JSON.stringify(db));
    let r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj, task_id: 'task-B', task_subject: 'endpoints' }), sb.env, env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /still has 1 open predecessor\(s\): .*"schema" \(triaged\)/);
    assert.equal(r.stdout, '');
    assert.equal(JSON.parse(fs.readFileSync(dbf, 'utf8')).tickets[b].status, 'triaged');
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj, task_id: 'task-B', task_subject: 'endpoints' }), sb.env, { ...env, CC_ANCHOR_TASK_MIRROR_GATE: '0' });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(dbf, 'utf8')).tickets[b].status, 'resolved');
    // someone else holds the claim => fail open (exit 0), logged
    const db2 = JSON.parse(fs.readFileSync(dbf, 'utf8'));
    db2.tickets[a].claim = { actor: 'bob', token: 't', expires_at: '2099-01-01T00:00:00Z' };
    fs.writeFileSync(dbf, JSON.stringify(db2));
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj, task_id: 'task-A', task_subject: 'schema' }), sb.env, env);
    assert.equal(r.status, 0);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /cannot claim .* \(already_claimed\)/);
    // broken module => exit 0
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj }), sb.env, { ...env, CC_ANCHOR_SEA_MODULE: '/nonexistent' });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    r = hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj }), sb.env, { ...env, CC_ANCHOR_SEA_MODULE: '/nonexistent' });
    assert.equal(r.status, 0);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /sea-lite module not found/);
  } finally { sb.cleanup(); }
});

const REAL_SEA = ['/home/claude/sea-lite/dist/index.js', path.join(os.homedir(), '.claude/plugins/cache/isokron-plugins/sea-lite/0.1.1/node_modules/sea-lite/dist/index.js')].find((f) => fs.existsSync(f));
test('Task mirror against the real sea-lite library (skipped when not installed)', { skip: !REAL_SEA && 'sea-lite not available' }, () => {
  const sb = sandbox();
  try {
    const data = path.join(sb.base, 'kl');
    const env = { CC_ANCHOR_TASK_MIRROR: '1', CC_ANCHOR_SEA_MODULE: REAL_SEA, CC_ANCHOR_SEA_DATA_DIR: data };
    let r = hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0, r.stderr);
    const map = JSON.parse(fs.readFileSync(path.join(sb.run, 'tasks.json'), 'utf8'));
    assert.match(map['task-001'], /^[0-9a-f-]{36}$/);
    hook('task-created.sh', fixture('taskcreated.json', { cwd: sb.proj }), sb.env, env);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /\(replayed\)/, 'sea-lite idempotency_key replay');
    r = hook('task-completed.sh', fixture('taskcompleted.json', { cwd: sb.proj }), sb.env, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /resolved/);
  } finally { sb.cleanup(); }
});

// ───────────── InstructionsLoaded + belt-and-braces reassert ─────────────

test('InstructionsLoaded (docs payloads): stamps state + card; compact without a SessionStart injection queues a one-shot reassert on the next prompt', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'stamp'], sb.env);
    let r = hook('instructions-loaded.sh', fixture('instructionsloaded-session-start.json', { cwd: sb.proj, file_path: `${sb.proj}/CLAUDE.md` }), sb.env);
    assert.equal(r.status, 0); assert.equal(r.stdout, '', 'output is discarded by Claude Code anyway');
    hook('instructions-loaded.sh', fixture('instructionsloaded-session-start.json', { cwd: sb.proj, file_path: `${sb.proj}/.claude/rules/db.md`, memory_type: 'Project' }), sb.env);
    assert.equal(sb.readState().instructions_files, 'CLAUDE.md, .claude/rules/db.md');
    assert.match(sb.readCard(), /^Instructions: CLAUDE\.md, \.claude\/rules\/db\.md \(loaded \d{4}-.*, session_start\)$/m);
    assert.ok(sb.readCard().split('\n').filter(Boolean).length <= 25);
    // happy path: PreCompact → SessionStart(compact) → InstructionsLoaded(compact): no reassert
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj }), sb.env);
    hook('session-start.sh', fixture('sessionstart-compact.json', { cwd: sb.proj }), sb.env);
    hook('instructions-loaded.sh', fixture('instructionsloaded-compact.json', { cwd: sb.proj, file_path: `${sb.proj}/CLAUDE.md` }), sb.env);
    assert.notEqual(sb.readState().reassert_pending, '1');
    r = hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.stdout, '');
    // missed injection: PreCompact → (no SessionStart) → InstructionsLoaded(compact) => next prompt carries the card once
    hook('pre-compact.sh', fixture('precompact-manual.json', { cwd: sb.proj, trigger: 'auto' }), sb.env);
    hook('instructions-loaded.sh', fixture('instructionsloaded-compact.json', { cwd: sb.proj, file_path: `${sb.proj}/CLAUDE.md` }), sb.env);
    assert.equal(sb.readState().reassert_pending, '1');
    r = hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj }), sb.env);
    assert.ok(r.json, r.stdout);
    assert.match(r.json.hookSpecificOutput.additionalContext, /^ANCHOR — verbatim, read before anything else \(re-asserted/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Goal: stamp/);
    r = hook('user-prompt-submit.sh', fixture('userpromptsubmit.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.stdout, '', 'one shot');
  } finally { sb.cleanup(); }
});

test('SessionStart(resume) relays the docs cost fields as a drift line', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'g'], sb.env);
    const r = hook('session-start.sh', fixture('sessionstart-resume-cost.json', { cwd: sb.proj }), sb.env);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Resumed after 90 min idle \(prompt cache likely expired: true\)/);
    assert.equal(sb.readState().compact_injected_at, undefined, 'only compact stamps the injection marker');
  } finally { sb.cleanup(); }
});

// ───────────── Worktree pack (opt-in) ─────────────

test('WorktreeCreate/Remove pack (docs payloads): creates .claude/worktrees/<name> on branch worktree-<name>, prints the path last, copies the card; remove queues releases and deletes dir + branch', () => {
  const sb = sandbox();
  try {
    const git = (...a) => { const r = spawnSyncGit(sb.proj, a); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    fs.rmSync(path.join(sb.proj, '.git'), { recursive: true });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(sb.proj, 'README'), 'x'); git('add', '.'); git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(sb.proj, '.worktreeinclude'), '.env\n');
    fs.writeFileSync(path.join(sb.proj, '.env'), 'SECRET=1');
    cli(['set', 'goal', 'wt'], sb.env);
    let r = hook('worktree-create.sh', fixture('worktreecreate.json', { cwd: sb.proj }), sb.env);
    assert.equal(r.status, 0, r.stderr);
    const wt = r.stdout.trim().split('\n').pop();
    assert.equal(wt, path.join(sb.proj, '.claude', 'worktrees', 'feature-auth'));
    assert.ok(fs.existsSync(path.join(wt, 'README')));
    assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=1', '.worktreeinclude honoured');
    assert.match(git('branch', '--list', 'worktree-feature-auth'), /worktree-feature-auth/);
    assert.match(fs.readFileSync(path.join(wt, '.claude', 'anchor.md'), 'utf8'), /Goal: wt/);
    assert.match(sb.readCard(), /WorktreeCreate feature-auth/);
    assert.ok(JSON.parse(sb.readState().worktrees)[wt]);
    // a claim taken inside the worktree, then removal => pending release + dir and branch gone
    // No background lease heartbeat: it would still be writing under the sandbox HOME when the test cleans up (macOS ENOTEMPTY).
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: wt }), sb.env, { CC_ANCHOR_HEARTBEAT: '0' });
    r = hook('worktree-remove.sh', fixture('worktreeremove.json', { cwd: sb.proj, worktree_path: wt }), sb.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(wt));
    assert.equal(git('branch', '--list', 'worktree-feature-auth'), '');
    assert.equal(pendingOf(sb)[0]?.ticket_id, 'tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2');
    assert.match(pendingOf(sb)[0].reason, /worktree feature-auth removed/);
    assert.match(sb.readCard(), /WorktreeRemove feature-auth/);
    r = hook('worktree-create.sh', fixture('worktreecreate.json', { cwd: sb.proj, name: '' }), sb.env);
    assert.notEqual(r.status, 0, 'no name => creation fails loudly (never silently)');
  } finally { sb.cleanup(); }
});
import { spawnSync as _spawnSync } from 'node:child_process';
function spawnSyncGit(cwd, args) { return _spawnSync('git', args, { cwd, encoding: 'utf8' }); }

test('hooks install worktree / orient-mcp write the documented shapes into settings.json and uninstall cleanly', () => {
  const sb = sandbox();
  try {
    const settings = path.join(sb.home, '.claude', 'settings.json');
    let r = cli(['hooks', 'install', 'worktree'], sb.env);
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(j.hooks.WorktreeCreate[0].hooks[0].type, 'command');
    assert.equal(j.hooks.WorktreeCreate[0].hooks[0].command, 'bash');
    assert.match(j.hooks.WorktreeCreate[0].hooks[0].args[0], /\/\.claude\/cc-anchor\/worktree-create\.sh$/);
    assert.ok(fs.existsSync(j.hooks.WorktreeCreate[0].hooks[0].args[0]));
    assert.ok(fs.existsSync(path.join(sb.home, '.claude', 'cc-anchor', 'claims.jq')), 'runtime copied next to it');
    r = cli(['hooks', 'install', 'orient-mcp'], sb.env);
    assert.equal(r.status, 1, 'server name required');
    r = cli(['hooks', 'install', 'orient-mcp', '--server', 'kronicle-lite'], sb.env);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const h = j.hooks.SessionStart[0];
    assert.equal(h.matcher, 'compact|clear', 'launch-time SessionStart skips mcp_tool hooks (hooks reference)');
    assert.deepEqual(Object.keys(h.hooks[0]).sort(), ['input', 'server', 'statusMessage', 'timeout', 'tool', 'type']);
    assert.equal(h.hooks[0].type, 'mcp_tool');
    assert.equal(h.hooks[0].server, 'kronicle-lite');
    assert.equal(h.hooks[0].tool, 'get_system_state');
    assert.ok(!('since_cursor' in h.hooks[0].input), 'input can only template ${fields} of the hook input; the cursor is on disk');
    assert.deepEqual(orientMcpHook('x').SessionStart[0].hooks[0].input, { focus: 'orientation', budget_tokens: 1500 });
    assert.deepEqual(Object.keys(worktreePackHooks('/d')), ['WorktreeCreate', 'WorktreeRemove']);
    cli(['hooks', 'install', 'orient-mcp', '--server', 'plugin:kronicle-lite:kronicle-lite'], sb.env);
    j = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(j.hooks.SessionStart.length, 1, 're-install replaces, never duplicates');
    cli(['hooks', 'uninstall', 'orient-mcp'], sb.env);
    cli(['hooks', 'uninstall', 'worktree'], sb.env);
    j = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(j.hooks, undefined);
  } finally { sb.cleanup(); }
});

// ───────────── Cursor port ─────────────

const cursorHook = (ev, payload, env, extra = {}) => {
  const r = _spawnSync('bash', [path.join(ROOT, 'cursor', 'adapter.sh'), ev], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...env, ...extra } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
};

test('Cursor adapter: sessionStart → additional_context; preCompact stamps; postToolUse (tool_output string, MCP:<tool>) feeds the trail and claims', () => {
  const sb = sandbox();
  try {
    const env = { ...sb.env }; delete env.CLAUDE_PROJECT_DIR;   // Cursor sets no CLAUDE_PROJECT_DIR
    const ws = { workspace_roots: [sb.proj] };
    let r = cursorHook('sessionStart', fixture('cursor-sessionstart.json', ws), env);
    assert.equal(r.status, 0); assert.equal(r.stdout, '', 'no card yet => silent');
    cli(['set', 'goal', 'cursor goal'], sb.env);
    r = cursorHook('sessionStart', fixture('cursor-sessionstart.json', ws), env);
    assert.ok(r.json, r.stdout);
    assert.deepEqual(Object.keys(r.json), ['additional_context']);
    assert.match(r.json.additional_context, /^ANCHOR — session start \(startup\)[\s\S]*Goal: cursor goal/);
    r = cursorHook('postToolUse', fixture('cursor-posttooluse.json', { ...ws, cwd: sb.proj }), env);
    assert.equal(r.stdout, '');
    assert.equal(parseCard(sb.readCard()).trail[0].tool, 'Shell');
    assert.equal(parseCard(sb.readCard()).trail[0].target, 'npm test');
    r = cursorHook('postToolUse', fixture('cursor-posttooluse.json', { ...ws, cwd: sb.proj, tool_name: 'MCP:sea_claim', tool_input: { ticket_ids: ['tkt_c1'] }, tool_output: JSON.stringify({ claims: [{ ticket_id: 'tkt_c1', claim_token: 'ctok', expires_at: '2099-01-01T00:00:00Z' }] }) }), env);
    assert.equal(claimsOf(sb).tkt_c1.claim_token, 'ctok', 'MCP:<tool> mapped onto the sea_* regex');
    r = cursorHook('preCompact', fixture('cursor-precompact.json', ws), env);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    assert.equal(sb.readState().compact_trigger, 'auto');
    assert.equal(sb.readState().compact_count, '1');
  } finally { sb.cleanup(); }
});

test('Cursor adapter: stop → followup_message (claim guard), loop_count>0 maps to stop_hook_active; preToolUse Write → permission deny; subagentStop has no agent id (parity gap) => silent', () => {
  const sb = sandbox();
  try {
    const env = { ...sb.env }; delete env.CLAUDE_PROJECT_DIR;
    const ws = { workspace_roots: [sb.proj] };
    cursorHook('postToolUse', fixture('cursor-posttooluse.json', { ...ws, cwd: sb.proj, tool_name: 'MCP:sea_claim', tool_output: JSON.stringify({ claims: [{ ticket_id: 'tkt_c1', claim_token: 'ctok', expires_at: '2099-01-01T00:00:00Z' }] }) }), env);
    let r = cursorHook('stop', fixture('cursor-stop.json', ws), env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.ok(r.json, r.stdout);
    assert.deepEqual(Object.keys(r.json), ['followup_message']);
    assert.match(r.json.followup_message, /release or hand off your sea-lite claim first[\s\S]*tkt_c1/);
    r = cursorHook('stop', fixture('cursor-stop.json', { ...ws, loop_count: 1 }), env, { CC_ANCHOR_CLAIM_GUARD: '1' });
    assert.equal(r.stdout, '');
    const bin = fakeCli(sb, 'sea-lite', `[[ "$1" == scope-check ]] && { echo '{"schema":"sea-lite.scope-check/1","ok":false,"conflicts":[{"holder":"b","holder_label":"b","ticket_id":"t","title":"x","held":["src/**"],"claim_expires_at":"2099"}]}'; exit 1; }; exit 2`);
    r = cursorHook('preToolUse', fixture('cursor-pretooluse.json', { ...ws, cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/a.ts`, content: '' } }), env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin });
    assert.equal(r.json?.permission, 'deny');
    assert.match(r.json.agent_message, /scope guard/);
    r = cursorHook('subagentStop', fixture('cursor-subagentstop.json', ws), env, { CC_ANCHOR_SEA: '1' });
    assert.equal(r.stdout, '', 'Cursor subagentStop carries no subagent id, so nothing can be attributed');
  } finally { sb.cleanup(); }
});

test('cursor install writes .cursor/hooks.json (version 1, project-relative commands) + scripts; uninstall removes only ours', () => {
  const sb = sandbox();
  try {
    const hf = path.join(sb.proj, '.cursor', 'hooks.json');
    fs.mkdirSync(path.dirname(hf), { recursive: true });
    fs.writeFileSync(hf, JSON.stringify({ version: 1, hooks: { stop: [{ command: './mine.sh' }] } }));
    let r = cli(['cursor', 'install'], sb.env);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(fs.readFileSync(hf, 'utf8'));
    assert.equal(j.version, 1);
    assert.deepEqual(j.hooks.stop.map((h) => h.command), ['./mine.sh', 'bash .cursor/hooks/cc-anchor/adapter.sh stop']);
    assert.equal(j.hooks.stop[1].loop_limit, 2);
    assert.equal(j.hooks.preToolUse[0].matcher, 'Write');
    assert.deepEqual(Object.keys(j.hooks).sort(), ['postToolUse', 'preCompact', 'preToolUse', 'sessionStart', 'stop', 'subagentStop']);
    assert.ok(fs.existsSync(path.join(sb.proj, '.cursor', 'hooks', 'cc-anchor', 'scripts', 'lib.sh')));
    // the installed copy runs from the project root exactly as Cursor would run it
    const run = _spawnSync('bash', ['.cursor/hooks/cc-anchor/adapter.sh', 'sessionStart'], { cwd: sb.proj, input: JSON.stringify(fixture('cursor-sessionstart.json', { workspace_roots: [sb.proj] })), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: sb.home } });
    assert.equal(run.status, 0, run.stderr);
    cli(['set', 'goal', 'x'], sb.env);
    const run2 = _spawnSync('bash', ['.cursor/hooks/cc-anchor/adapter.sh', 'sessionStart'], { cwd: sb.proj, input: JSON.stringify(fixture('cursor-sessionstart.json', { workspace_roots: [sb.proj] })), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: sb.home } });
    assert.match(JSON.parse(run2.stdout).additional_context, /Goal: x/);
    r = cli(['cursor', 'uninstall'], sb.env);
    assert.deepEqual(JSON.parse(fs.readFileSync(hf, 'utf8')).hooks, { stop: [{ command: './mine.sh' }] });
    assert.ok(!fs.existsSync(path.join(sb.proj, '.cursor', 'hooks', 'cc-anchor')));
  } finally { sb.cleanup(); }
});

// ───────────── CLI: claims, config, doctor ─────────────

test('claims / config / doctor report the lifecycle pack state', () => {
  const sb = sandbox();
  try {
    assert.match(cli(['claims'], sb.env).stdout, /no live sea-lite claims/);
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj, agent_id: 'def456' }), sb.env);
    hook('subagent-stop.sh', fixture('subagentstop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_SEA: '1' });
    assert.match(cli(['claims'], sb.env).stdout, /tkt_01HZX4K3Q9R8M2N7P6V5W4X3Y2 {2}held by subagent def456 {2}via sea_claim .*\[PENDING RELEASE\]/);
    const j = JSON.parse(cli(['claims', '--json'], sb.env).stdout);
    assert.equal(j.live.length, 1); assert.equal(j.pending.length, 1);
    const d = JSON.parse(cli(['doctor', '--json'], sb.env).stdout);
    assert.equal(d['live claims'], '1 (1 pending release)');
    assert.match(d['hooks.json events'], /SubagentStop/);
    assert.equal(d['sea-lite'], 'false');
    assert.deepEqual(Object.keys(JSON.parse(cli(['config', '--json'], sb.env).stdout)), Object.keys(CONFIG_KEYS));
    fs.writeFileSync(path.join(sb.proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'sea-lite': { command: 'npx', args: ['-y', 'sea-lite', 'serve'] } } }));
    assert.match(JSON.parse(cli(['doctor', '--json'], sb.env).stdout)['sea-lite'], /^true via/);
  } finally { sb.cleanup(); }
});

// ───────────── more edges ─────────────

test('claims: sea_create with claim_seconds adds; sea_refresh bumps expiry; sea_create without a claim adds nothing', () => {
  const sb = sandbox();
  try {
    const create = (claim) => fixture('posttooluse-sea-claim.json', { cwd: sb.proj, tool_name: 'mcp__sea-lite__sea_create', tool_input: { title: 't', claim_seconds: claim ? 120 : undefined }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ ticket: { id: claim ? 'tkt_created' : 'tkt_plain', title: 't', status: 'triaged' }, claim_token: claim ? 'clm_create' : null, claim_expires_at: claim ? '2099-01-01T00:02:00Z' : null, possible_duplicates: [], replayed: false }) }] } });
    hook('post-tool-use.sh', create(false), sb.env);
    assert.ok(!fs.existsSync(path.join(sb.run, 'claims.json')) || !('tkt_plain' in claimsOf(sb)));
    hook('post-tool-use.sh', create(true), sb.env);
    assert.equal(claimsOf(sb).tkt_created.claim_token, 'clm_create');
    assert.equal(claimsOf(sb).tkt_created.expires, '2099-01-01T00:02:00Z');
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj, tool_name: 'mcp__sea-lite__sea_refresh', tool_input: { ticket_id: 'tkt_crea', claim_token: 'clm_create', extend_by_seconds: 600 }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ ticket_id: 'tkt_created', expires_at: '2099-01-01T00:12:00Z' }) }] } }), sb.env);
    assert.equal(claimsOf(sb).tkt_created.expires, '2099-01-01T00:12:00Z', 'refresh by prefix');
  } finally { sb.cleanup(); }
});

test('CLI resolution order: CC_ANCHOR_<NAME>_BIN > PATH > plugin cache node_modules/<name>/dist/cli.js', () => {
  const sb = sandbox();
  try {
    const cached = path.join(sb.home, '.claude', 'plugins', 'cache', 'mk', 'sea-lite', '0.9.0', 'node_modules', 'sea-lite', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const find = (extra = {}) => _spawnSync('bash', ['-c', `. "${path.join(SCRIPTS, 'lib.sh')}"; cc_resolve "${sb.proj}"; cc_find_cli sea-lite`], { encoding: 'utf8', env: { ...sb.env, ...extra } }).stdout;
    assert.equal(find({ PATH: '/usr/bin:/bin' }), cached, 'plugin cache found via HOME');
    const onPath = fakeCli(sb, 'sea-lite', 'exit 0');
    assert.equal(find({ PATH: `${path.join(sb.base, 'bin')}:/usr/bin:/bin` }), onPath, 'PATH beats the cache');
    assert.equal(find({ CC_ANCHOR_SEA_LITE_BIN: '/explicit/sea-lite' }), '/explicit/sea-lite', 'env beats everything');
    // cc_run_cli runs a cli.js through node. PATH holds node and nothing
    // else: under `npm test` process.env.PATH starts with node_modules/.bin,
    // which has the real sea-lite once CI installs it, and PATH beats the cache.
    const nodeBin = path.join(sb.base, 'nodebin'); fs.mkdirSync(nodeBin); fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
    const nodePath = `${nodeBin}:/usr/bin:/bin`;
    const run = _spawnSync('bash', ['-c', `. "${path.join(SCRIPTS, 'lib.sh')}"; cc_resolve "${sb.proj}"; cc_run_cli sea-lite scope-check --paths x`], { encoding: 'utf8', env: { ...sb.env, PATH: nodePath, HOME: sb.home } });
    assert.equal(run.stdout, '["scope-check","--paths","x"]');
    assert.equal(JSON.parse(cli(['doctor', '--json'], sb.env, { PATH: nodePath }).stdout)['sea-lite cli'], cached, 'anchor.mjs mirrors the same lookup');
  } finally { sb.cleanup(); }
});

test('config CLI: show/set/unset round-trip, coercion, unknown key rejected, --scope user', () => {
  const sb = sandbox();
  try {
    let r = cli(['config', 'set', 'scope_ttl', '45'], sb.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.proj, '.claude', 'cc-anchor.json'), 'utf8')).scope_ttl, 45);
    cli(['config', 'set', 'task_mirror', 'yes'], sb.env);
    assert.equal(JSON.parse(cli(['config', '--json'], sb.env).stdout).task_mirror, true);
    r = cli(['config', 'set', 'bogus', '1'], sb.env);
    assert.notEqual(r.status, 0);
    cli(['config', 'set', 'session_doc', 'true', '--scope', 'user'], sb.env);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.home, '.claude', 'cc-anchor', 'config.json'), 'utf8')).session_doc, true);
    assert.match(cli(['config'], sb.env).stdout, /session_doc {8}true {3}← .*config\.json/);
    cli(['config', 'unset', 'task_mirror'], sb.env);
    assert.equal(JSON.parse(cli(['config', '--json'], sb.env).stdout).task_mirror, false);
    // the shell side reads the same numbers (scope_ttl=45 means a verdict from 40 s ago is still fresh)
    const bin = fakeCli(sb, 'sea-lite', 'echo CALLED >> "$HOME/calls"; exit 0');
    const f = `${sb.proj}/t.ts`;
    hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: f } }), sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin });
    const cache = JSON.parse(fs.readFileSync(path.join(sb.run, 'scope-cache.json'), 'utf8'));
    cache[`abc123|${f}`].at -= 40; fs.writeFileSync(path.join(sb.run, 'scope-cache.json'), JSON.stringify(cache));
    hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: f } }), sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin });
    assert.equal(fs.readFileSync(path.join(sb.home, 'calls'), 'utf8').trim().split('\n').length, 1, 'still cached at 40 s with scope_ttl=45');
  } finally { sb.cleanup(); }
});

test('PreToolUse scope guard: NotebookEdit notebook_path and Windows backslash paths are normalised before the check', () => {
  const sb = sandbox();
  try {
    const calls = path.join(sb.base, 'calls');
    const bin = fakeCli(sb, 'sea-lite', `echo "\${@: -1}" >> "${calls}"; exit 0`);
    const on = { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: bin };
    hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_name: 'NotebookEdit', tool_input: { notebook_path: `${sb.proj}/nb.ipynb`, new_source: '' } }), sb.env, on);
    hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_name: 'Write', tool_input: { file_path: 'C:\\project\\src\\index.ts', content: '' } }), sb.env, on);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [`${sb.proj}/nb.ipynb`, 'C:/project/src/index.ts']);
    const r = hook('pre-tool-use.sh', fixture('pretooluse-edit.json', { cwd: sb.proj, tool_name: 'Edit', tool_input: { old_string: 'a', new_string: 'b' } }), sb.env, on);
    assert.equal(r.stdout, '', 'no path => nothing to check');
  } finally { sb.cleanup(); }
});

test('Stop: no card on disk => session_doc skipped but the claim guard still fires; empty stdin fails open', () => {
  const sb = sandbox();
  try {
    hook('post-tool-use.sh', fixture('posttooluse-sea-claim.json', { cwd: sb.proj }), sb.env);
    fs.rmSync(sb.card);
    const bin = fakeCli(sb, 'kronicle-lite', 'echo PUT >> "$HOME/puts"; exit 0');
    const r = hook('stop.sh', fixture('stop.json', { cwd: sb.proj }), sb.env, { CC_ANCHOR_CLAIM_GUARD: '1', CC_ANCHOR_SESSION_DOC: '1', CC_ANCHOR_SYNC: '1', CC_ANCHOR_KRONICLE_LITE_BIN: bin });
    assert.equal(r.json?.decision, 'block');
    assert.ok(!fs.existsSync(path.join(sb.home, 'puts')), 'nothing to put without a card');
    assert.deepEqual([hook('stop.sh', '', sb.env).status, hook('stop.sh', 'nope', sb.env).stdout], [0, '']);
    assert.deepEqual([hook('subagent-stop.sh', '', sb.env).status, hook('instructions-loaded.sh', '{}', sb.env).stdout, hook('task-created.sh', '', sb.env).status, hook('pre-tool-use.sh', '{', sb.env).stdout], [0, '', 0, '']);
  } finally { sb.cleanup(); }
});

// Test seam for the sea-lite stress harnesses (tests/stress/*.sh): with
// tests/support/deadline-seam.sh sourced after lib.sh (a test copy of
// scripts/, never the shipped hooks) and CC_ANCHOR_TEST_DEADLINE_DIR set,
// the CLI deadline is an event the test fires (a double writes a line to
// $CC_ANCHOR_DEADLINE and blocks), never the clock — the real CLI missing
// scope_timeout under load made the stress cases flaky. `to` is 600 s
// here: only the event can end the hung call.
const SEAM = path.join(ROOT, 'tests', 'support', 'deadline-seam.sh');
test('test-only deadline seam (tests/support/deadline-seam.sh): the deadline fires only on the event, kills the process group, exits 124; a normal call keeps its output and exit code', () => {
  const sb = sandbox();
  try {
    const dl = path.join(sb.base, 'deadline');
    fs.mkdirSync(dl);
    const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    // spawnSync's own timeout is only a safety net: it returns once nothing holds stdout.
    const run = (cmd) => _spawnSync('bash', ['-c', `. ${q(path.join(SCRIPTS, 'lib.sh'))}; . ${q(SEAM)}; cc_with_timeout 600 bash -c ${q(cmd)}; echo "rc=$?"`], { encoding: 'utf8', timeout: 120000, env: { ...sb.env, CC_ANCHOR_TEST_DEADLINE_DIR: dl } });
    const ok = run('echo out; exit 3');
    assert.equal(ok.stdout, 'out\nrc=3\n', ok.stderr);
    // The double fires its deadline and hangs; its child holds stdout, so
    // this returns only if the whole process group was killed.
    const hung = run('sleep 300 & echo fire > "$CC_ANCHOR_DEADLINE"; sleep 300');
    assert.equal(hung.error, undefined, 'returned without the safety-net timeout');
    assert.equal(hung.stdout, 'rc=124\n', hung.stderr);
    assert.deepEqual(fs.readdirSync(dl), [], 'no FIFO or marker left behind');
  } finally { sb.cleanup(); }
});

// 0.6.0 review: the seam used to sit in the shipped lib.sh behind
// CC_ANCHOR_TEST_DEADLINE_DIR alone. With /nonexistent the scope guard
// allowed an edit inside another session's claim in 42 ms (exit 125); with a
// real directory a hung sea-lite was never cut off. In production the
// variable must do nothing.
test('production hooks: CC_ANCHOR_TEST_DEADLINE_DIR neither shortens nor removes a CLI deadline, and the scope guard still denies (0.6.0 review)', () => {
  const sb = sandbox();
  try {
    const dl = path.join(sb.base, 'deadline');
    fs.mkdirSync(dl);
    const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const run = (to, cmd, extra) => _spawnSync('bash', ['-c', `. ${q(path.join(SCRIPTS, 'lib.sh'))}; cc_with_timeout ${to} bash -c ${q(cmd)}; echo "rc=$?"`], { encoding: 'utf8', timeout: 120000, env: { ...sb.env, ...extra } });
    for (const dir of ['/nonexistent', dl]) {
      for (const fallback of ['0', '1']) {
        const env = { CC_ANCHOR_TEST_DEADLINE_DIR: dir, CC_ANCHOR_TEST_NO_TIMEOUT_BIN: fallback };
        const ok = run(30, 'echo out; exit 3', env);
        assert.equal(ok.stdout, 'out\nrc=3\n', `normal call kept (dir=${dir}, fallback=${fallback}) ${ok.stderr}`);
        // Hung, with a child holding stdout: returns only when the clock deadline kills the group.
        const t0 = Date.now();
        const hung = run(1, 'sleep 300 & sleep 300', env);
        const ms = Date.now() - t0;
        assert.equal(hung.error, undefined, `clock deadline still applies (dir=${dir}, fallback=${fallback})`);
        assert.equal(hung.stdout, 'rc=124\n', hung.stderr);
        assert.ok(ms < 30000, `${ms} ms`);
      }
    }
    assert.deepEqual(fs.readdirSync(dl), [], 'nothing made in the directory');
    // End to end through the scope guard.
    const conflict = JSON.stringify({ schema: 'sea-lite.scope-check/1', ok: false, conflicts: [{ ticket_id: 'tkt_X', title: 'X', holder: 'b', holder_label: 'b', held: ['src/**'], claim_expires_at: '2099' }] });
    const deny = fakeCli(sb, 'sea-lite', `echo '${conflict}'; exit 1`);
    const p = fixture('pretooluse-edit.json', { cwd: sb.proj, tool_input: { file_path: `${sb.proj}/src/login.ts` } });
    for (const dir of ['/nonexistent', dl]) {
      fs.rmSync(path.join(sb.run, 'scope-cache.json'), { force: true });
      const r = hook('pre-tool-use.sh', p, sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: deny, CC_ANCHOR_TEST_DEADLINE_DIR: dir });
      assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny', `dir=${dir}: ${r.stdout} ${r.stderr}`);
    }
    // A hung sea-lite with a real directory is still cut off at scope_timeout (fail-open, as documented).
    const hang = fakeCli(sb, 'sea-lite-hang', 'sleep 30; exit 1');
    fs.rmSync(path.join(sb.run, 'scope-cache.json'), { force: true });
    const t0 = Date.now();
    const r = hook('pre-tool-use.sh', p, sb.env, { CC_ANCHOR_SCOPE_GUARD: '1', CC_ANCHOR_SEA_LITE_BIN: hang, CC_ANCHOR_SCOPE_TIMEOUT: '1', CC_ANCHOR_TEST_DEADLINE_DIR: dl });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, 'fail-open on timeout, unchanged');
    assert.ok(ms < 15000, `bounded by scope_timeout, not by the 30 s hang: ${ms} ms`);
    assert.match(fs.readFileSync(path.join(sb.run, 'log'), 'utf8'), /exited 124 \(crash or timeout\)/);
    // And nothing on the hook path mentions it.
    for (const f of fs.readdirSync(SCRIPTS)) {
      assert.doesNotMatch(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'), /TEST_DEADLINE|CC_ANCHOR_DEADLINE|deadline-seam/, `scripts/${f} carries no deadline seam`);
    }
  } finally { sb.cleanup(); }
});
