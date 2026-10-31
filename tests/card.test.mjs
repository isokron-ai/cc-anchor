// Card format: parse/render round-trip, line cap, invariants, hand edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseCard, renderTop, MARKER, VERSION_LINE, MAX_LINES, resolvePaths } from '../scripts/anchor.mjs';
import { sandbox, cli, postTool } from './helpers.mjs';

const SAMPLE = `# ANCHOR — demo
${VERSION_LINE}
Project: A plugin that survives compaction.
Goal: Ship v0.1.0
Invariants:
- never force-push main
- never edit dist/ by hand
${MARKER}
Trail (last 5 tool calls, newest first):
- 2026-10-31T10:00:02Z Edit src/a.ts
- 2026-10-31T10:00:01Z Read src/a.ts
Cursor: sxt1c.42.abcd1234
Compacted: 2026-10-31T09:50:00Z
Refreshed: 2026-10-31T09:30:00Z
`;

test('parseCard reads every field of a full card', () => {
  const c = parseCard(SAMPLE);
  assert.equal(c.title, 'ANCHOR — demo');
  assert.equal(c.project, 'A plugin that survives compaction.');
  assert.equal(c.goal, 'Ship v0.1.0');
  assert.deepEqual(c.invariants, ['never force-push main', 'never edit dist/ by hand']);
  assert.equal(c.trail.length, 2);
  assert.deepEqual(c.trail[0], { ts: '2026-10-31T10:00:02Z', tool: 'Edit', target: 'src/a.ts' });
  assert.equal(c.cursor, 'sxt1c.42.abcd1234');
  assert.equal(c.compacted, '2026-10-31T09:50:00Z');
  assert.equal(c.refreshed, '2026-10-31T09:30:00Z');
  assert.equal(c.hasMarker, true);
});

test('renderTop(parseCard(x)) round-trips the hand-edited top byte-for-byte', () => {
  const c = parseCard(SAMPLE);
  const top = SAMPLE.slice(0, SAMPLE.indexOf(MARKER));
  assert.equal(renderTop(c), top);
});

test('round-trip preserves unknown hand-written lines in the top section', () => {
  const text = SAMPLE.replace('Invariants:', 'Owner: Joshua (off-grid, AZ)\nInvariants:');
  const c = parseCard(text);
  assert.deepEqual(c.extraTop, ['Owner: Joshua (off-grid, AZ)']);
  const top = text.slice(0, text.indexOf(MARKER));
  assert.equal(renderTop(c), top);
});

test('parseCard tolerates a card with no marker (whole file is the top)', () => {
  const c = parseCard('# ANCHOR\nGoal: only a goal\n');
  assert.equal(c.goal, 'only a goal');
  assert.equal(c.hasMarker, false);
  assert.deepEqual(c.trail, []);
  assert.equal(c.cursor, null);
});

test('parseCard treats "never" footers and placeholder invariants as unset', () => {
  const c = parseCard(`# A\nInvariants:\n- (none — add one)\n${MARKER}\nCompacted: never\nRefreshed: never\n`);
  assert.deepEqual(c.invariants, []);
  assert.equal(c.compacted, null);
  assert.equal(c.refreshed, null);
});

test('renderTop emits placeholders for unset fields', () => {
  const top = renderTop({ title: 'ANCHOR — x', project: null, goal: null, invariants: [] });
  assert.match(top, /^Project: \(unset/m);
  assert.match(top, /^Goal: \(unset/m);
  assert.match(top, /^- \(none/m);
});

test('rendered card never exceeds MAX_LINES even with 8 invariants and a cursor', () => {
  const sb = sandbox();
  try {
    for (let i = 1; i <= 8; i++) assert.equal(cli(['add-invariant', `never do thing ${i}`], sb.env).status, 0);
    assert.equal(cli(['set', 'project', 'p'], sb.env).status, 0);
    fs.writeFileSync(path.join(sb.proj, '.cc-anchor-cursor'), 'sxt1c.9.deadbeef\n');
    for (let i = 0; i < 12; i++) assert.equal(postTool(sb.env, 'Read', { file_path: `${sb.proj}/f${i}` }).status, 0);
    const lines = sb.readCard().split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
    assert.ok(lines.length <= MAX_LINES, `card has ${lines.length} lines`);
    assert.ok(lines.some((l) => l.startsWith('Cursor: sxt1c.9.deadbeef')));
    assert.equal(parseCard(sb.readCard()).invariants.length, 8);
    assert.ok(parseCard(sb.readCard()).trail.length >= 1);
  } finally { sb.cleanup(); }
});

test('9th invariant is refused so the card stays within budget', () => {
  const sb = sandbox();
  try {
    for (let i = 1; i <= 8; i++) cli(['add-invariant', `inv ${i}`], sb.env);
    const r = cli(['add-invariant', 'inv 9'], sb.env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /max 8 invariants/);
  } finally { sb.cleanup(); }
});

test('set goal / set project / add-invariant / rm-invariant edit the top and keep the trail', () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Read', { file_path: `${sb.proj}/README.md` });
    assert.equal(cli(['set', 'goal', 'Ship it'], sb.env).status, 0);
    assert.equal(cli(['set', 'project', 'The project'], sb.env).status, 0);
    assert.equal(cli(['add-invariant', 'never A'], sb.env).status, 0);
    assert.equal(cli(['add-invariant', 'never B'], sb.env).status, 0);
    assert.equal(cli(['rm-invariant', '1'], sb.env).status, 0);
    const c = parseCard(sb.readCard());
    assert.equal(c.goal, 'Ship it');
    assert.equal(c.project, 'The project');
    assert.deepEqual(c.invariants, ['never B']);
    assert.equal(c.trail[0].target, 'README.md');
  } finally { sb.cleanup(); }
});

test('duplicate invariant is a no-op; unknown rm-invariant fails cleanly', () => {
  const sb = sandbox();
  try {
    cli(['add-invariant', 'never X'], sb.env);
    assert.match(cli(['add-invariant', 'never X'], sb.env).stdout, /already present/);
    const r = cli(['rm-invariant', 'nope'], sb.env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no invariant matches/);
  } finally { sb.cleanup(); }
});

test('multi-line goal text is collapsed to one line', () => {
  const sb = sandbox();
  try {
    cli(['set', 'goal', 'line one\nline two'], sb.env);
    assert.equal(parseCard(sb.readCard()).goal, 'line one line two');
  } finally { sb.cleanup(); }
});

test('hand edit to the top is detected by the next PostToolUse and bumps refreshed_at', () => {
  const sb = sandbox();
  try {
    postTool(sb.env, 'Read', { file_path: 'x' });
    assert.equal(sb.readState().refreshed_at, null, 'auto-created card has never been refreshed');
    const edited = sb.readCard().replace(/^Goal: .*$/m, 'Goal: hand-edited');
    fs.writeFileSync(sb.card, edited);
    postTool(sb.env, 'Read', { file_path: 'y' });
    const st = sb.readState();
    assert.ok(st.refreshed_at, 'refreshed_at stamped');
    assert.match(sb.readCard(), /^Goal: hand-edited$/m);
    assert.match(sb.readCard(), new RegExp(`^Refreshed: ${st.refreshed_at}$`, 'm'));
  } finally { sb.cleanup(); }
});

test('resolvePaths: project store when .git or .claude exists, home fallback otherwise, env override', () => {
  const sb = sandbox();
  try {
    const p = resolvePaths(sb.proj, sb.env);
    assert.equal(p.where, 'project');
    assert.equal(p.card, sb.card);
    const plain = path.join(sb.base, 'plain');
    fs.mkdirSync(plain);
    const h = resolvePaths(plain, sb.env);
    assert.equal(h.where, 'home');
    assert.ok(h.card.startsWith(path.join(sb.home, '.claude', 'cc-anchor')));
    assert.match(path.basename(h.dir), /^[0-9a-f]{12}$/);
    const e = resolvePaths(plain, { ...sb.env, CC_ANCHOR_DIR: '/tmp/elsewhere' });
    assert.equal(e.where, 'env');
    assert.equal(e.card, '/tmp/elsewhere/anchor.md');
    const forced = resolvePaths(sb.proj, { ...sb.env, CC_ANCHOR_HOME: '1' });
    assert.equal(forced.where, 'home');
  } finally { sb.cleanup(); }
});

test('shell and node agree on the home-fallback directory hash', () => {
  const sb = sandbox({ git: false });
  try {
    const node = resolvePaths(sb.proj, sb.env);
    postTool(sb.env, 'Read', { file_path: 'x' });
    assert.ok(fs.existsSync(node.card), `bash wrote ${node.card}`);
  } finally { sb.cleanup(); }
});
