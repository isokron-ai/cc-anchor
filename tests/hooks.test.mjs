// Hook I/O against payloads copied from the Claude Code hooks reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseCard } from '../scripts/anchor.mjs';
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

test('PostToolUse: cold hook run takes less than 50 ms wall (budget 20 ms on a dev box)', () => {
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
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const [ev, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      assert.equal(h.type, 'command', ev);
      assert.equal(h.command, 'bash', ev);
      assert.ok(Array.isArray(h.args) && h.args.length === 1, ev);
      const rel = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${ev}: ${rel} exists`);
      assert.ok(h.timeout > 0 && h.timeout <= 10, ev);
    }
  }
  assert.equal(hooks.PreCompact[0].matcher, 'manual|auto');
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact|fork');
  assert.equal(hooks.PostToolUse[0].matcher, '*');
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
