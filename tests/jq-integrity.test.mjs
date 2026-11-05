// Every scripts/*.jq compiles, stays small and has no runaway repetition (the
// 0.5.2 WIP owed.jq had one fragment repeated ~11.7k times, 7.6 MB), plus
// pinned golden outputs for owed.jq. From the PR #6 adversarial review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SCRIPTS } from './helpers.mjs';

const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.jq'));

test('there are jq scripts to check', () => assert.ok(files.length >= 4, files.join(',')));

for (const f of files) {
  test(`${f}: compiles, stays small, no runaway repetition`, () => {
    const p = path.join(SCRIPTS, f);
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(src.length < 64 * 1024, `${f} is ${src.length} bytes (budget 64 KiB)`);
    const counts = new Map();
    for (const l of src.split('\n').map((x) => x.trim()).filter((x) => x.length > 20)) counts.set(l, (counts.get(l) || 0) + 1);
    const [worst, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    assert.ok(n <= 5, `${f}: line repeated ${n}x: ${worst.slice(0, 80)}`);
    // other scripts need their own --arg set; a syntax error is what matters here
    const r = spawnSync('jq', ['-n', '--arg', 'mode', '__compile_only__', '--arg', 'fmt', 'x', '--arg', 'max', '1', '-f', p], { encoding: 'utf8', input: '' });
    assert.doesNotMatch(r.stderr, /syntax error/, `${f} does not compile: ${r.stderr}`);
  });
}

test('owed.jq golden: merge/feed outputs pinned', () => {
  const p = path.join(SCRIPTS, 'owed.jq');
  const jq = (args, input = '') => spawnSync('jq', [...args, '-f', p], { input, encoding: 'utf8' });
  assert.equal(jq(['-nr', '--arg', 'mode', 'merge', '--arg', 'owed', '{"k":"c:a"}\n{"k":"c:a"}\n{"k":"c:b"}', '--arg', 'done', 'c:b']).stdout, '{"k":"c:a"}\n');
  const feed = jq(['-c', '--arg', 'mode', 'feed'], JSON.stringify({ pending_count: 1, pending: [{ doc_slug: 'rb', seq: 2, change: 'superseded', severity: 'behavioral', current: { block_id: 'B2' }, read: { block_id: 'B1', head_seq: 1 }, old_text: 'a  b', new_text: 'c\nd' }] }));
  assert.equal(feed.stdout.trim(), '"{\\"p\\":[{\\"k\\":\\"c:B2\\",\\"slug\\":\\"rb\\",\\"seq\\":2,\\"cur\\":\\"B2\\",\\"tb\\":null,\\"rd\\":\\"B1\\",\\"new\\":\\"c d\\",\\"old\\":\\"a b\\",\\"line\\":\\"- rb (seq 2, superseded/behavioral; you read it at seq 1): read \\\\\\"a b\\\\\\" → now \\\\\\"c d\\\\\\"\\"}],\\"r\\":[]}"');
});
