// Unit tests for the kronicle-lite retraction push / pulse that need no
// kronicle-lite: the read-only classifier (scripts/readonly.jq, 0.5.1), the retraction
// renderer (scripts/retractions.jq, incl. the cosmetic flag kronicle-lite may
// add), inertness without kronicle-lite, and the fail-open paths with a fake
// CLI that hangs or crashes. The contract with the REAL CLI is in
// kronicle-contract.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SCRIPTS, sandbox, hook } from './helpers.mjs';

function classify(command, max = '8192') {
  const r = spawnSync('jq', ['-c', '--arg', 'max', max, '-f', path.join(SCRIPTS, 'readonly.jq')], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const ro = (c) => classify(c).ro;

// 0.5.1: while something is pending the gate lets only provably read-only Bash
// calls run; anything the classifier does not fully understand is not read-only.
test('readonly.jq: the allowlist — plain reads, pipelines, chains, /dev/null and fd redirections, comments', () => {
  for (const c of ['cat a.txt', 'ls -la', 'head -n 20 README.md | tail -5', 'grep -rn "deploy" src/ 2>/dev/null | wc -l', 'rg -n TODO src -g \'*.ts\'',
    "find . -name '*.md' -type f", 'wc -l a b', 'diff a b', 'jq .version package.json', 'pwd', 'which node', 'echo "$HOME/x"', 'printf \'%s\\n\' a',
    'cd svc && git status', 'git -C ../svc --no-pager log --oneline -5', 'git diff HEAD~1 -- \'*.ts\'', 'git show HEAD:README.md', 'git branch', 'git branch -a',
    'git branch --list "fix-*"', 'git branch --merged main', 'git rev-parse --abbrev-ref HEAD', 'git ls-files', 'git remote -v', 'less -R log.txt',
    'cat x >/dev/null 2>&1', 'ls 2>/dev/null', 'cat a &>/dev/null', 'echo hi >&2', '# git push\nls', 'ls # git push', 'g\'\'it log', 'c\\at a',
    'kronicle-lite get runbook --actor agent-a', 'npx -y kronicle-lite@0.8.0 pending --actor a --json', 'node node_modules/kronicle-lite/dist/cli.js orient --json',
    'sea-lite board --json', 'npx sea-lite show 12', '', '   ', 'ls;', 'cat a\ncat b']) {
    assert.equal(ro(c), true, `read-only: ${JSON.stringify(c)} — ${classify(c).why}`);
  }
});

test('readonly.jq: everything else is not read-only, with the reason', () => {
  const cases = {
    'git push': /`git push` is not on the read-only list/,
    'npm test': /`npm` is not on the read-only list/,
    './bin/deploy': /a path to a program or script/,
    'A=1; ls': /a variable assignment/,
    'ls > out.txt': /a redirection to a file/,
    'cat a >> log': /a redirection to a file/,
    'cat < in.txt': /a redirection to a file/,
    'cat <<EOF\nx\nEOF': /a here-document/,
    'wc -w <<<hello': /a here-string/,
    'cat <(./deploy.sh)': /process substitution/,
    '(ls)': /subshell/,
    '{ ls; }': /glob/,
    'echo $(git push)': /command substitution/,
    'echo "$(git push)"': /command substitution/,
    'echo `git push`': /backticks/,
    "echo $'a'": /\$'…'/,
    'echo ${x:-y}': /shell expansion/,
    'echo "$1"': /shell expansion/,
    'ls &': /background/,
    '$CMD x': /variable/,
    'find . -name x -delete': /find with -delete/,
    "find . -exec rm {} \\;": /glob|-exec/,
    'find . -ok rm {} ;': /glob|-ok/,
    'find . -name *.js': /unquoted variable, glob or brace in find/,
    'find . $X': /unquoted variable, glob or brace in find/,
    'rg --pre=sh x': /rg --pre/,
    'less +!git push x': /less option/,
    'less -o out x': /less option/,
    'git -c alias.x=push x': /git option `-c`/,
    'git log --output=x': /--output/,
    'git branch -D x': /git branch/,
    'git branch newbranch': /git branch/,
    'git remote add o u': /git remote/,
    'kronicle-lite put x f.md': /`kronicle-lite put` is not on the read-only list/,
    'sea-lite next': /`sea-lite next` is not on the read-only list/,
    'node x.js': /node/,
    "echo 'unterminated": /unbalanced quote/,
    'cat a ;; ls': /;;/,
    'ls\r': /does not parse/,
  };
  for (const [c, re] of Object.entries(cases)) {
    const r = classify(c);
    assert.equal(r.ro, false, `not read-only: ${JSON.stringify(c)}`);
    assert.match(r.why, re, `${JSON.stringify(c)}: ${r.why}`);
  }
});

test('readonly.jq: a command over pulse_max_bytes is not read-only, and is classified fast (H2-09)', () => {
  const big = `printf %s '${'x'.repeat(204800)}' > f; git push`;
  const t0 = Date.now();
  const r = classify(big);
  assert.equal(r.ro, false);
  assert.match(r.why, /longer than 8192 bytes/);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  assert.equal(r.head.length <= 120, true);
  assert.equal(classify('cat a', '3').ro, false, 'pulse_max_bytes is honoured');
});

// Adversarial corpus from agent-memory-bench stress/cca/pulse-corpus.sh, 85 cases. Under
// 0.5.1: W (world-changing) must never be read-only — denied while anything is pending;
// Q:ro must stay read-only; Q are harmless but not read-only (denied only while pending).
// Literal \\t / \\n are expanded like printf. tests/stress/ has the round-2 corpus too.
const CORPUS = [
  ["W", "git push origin main", "control"],
  ["W", "git -C ../svc push origin main", "git global option before subcommand"],
  ["W", "git --no-pager push", "git global option"],
  ["W", "git -c push.default=current push", "git -c option"],
  ["W", "git  push", "two spaces"],
  ["W", "git\\tpush", "tab"],
  ["W", "\"git\" push", "quoted command name"],
  ["W", "kubectl -n prod apply -f k8s/", "kubectl namespace flag before verb"],
  ["W", "kubectl --context prod apply -f k8s/", "kubectl context flag"],
  ["W", "terraform -chdir=infra apply -auto-approve", "terraform -chdir"],
  ["W", "TF_VAR_env=prod terraform apply", "env prefix"],
  ["W", "sudo -E terraform apply", "sudo flags"],
  ["W", "env -i PATH=/usr/bin ./deploy.sh", "env flags"],
  ["W", "bash -c \"kubectl apply -f x.yaml\"", "bash -c"],
  ["W", "sh -c 'git push'", "sh -c"],
  ["W", "eval \"$DEPLOY_CMD deploy\"", "eval"],
  ["W", "python3 -c \"import os; os.system('git push')\"", "python -c"],
  ["W", "node -e \"require('child_process').execSync('npm publish')\"", "node -e"],
  ["W", "make release", "make target"],
  ["W", "npm run deploy", "npm script named deploy"],
  ["W", "./scripts/deploy.sh --env prod", "script path"],
  ["W", "(cd svc && git push)", "subshell"],
  ["W", "{ git push; }", "brace group"],
  ["W", "cat <<EOF | bash\\ngit push\\nEOF", "here-doc piped to bash"],
  ["W", "ssh prod 'sudo systemctl restart api && ./deploy'", "ssh"],
  ["W", "nohup ./deploy.sh &", "nohup background"],
  ["W", "time git push", "time"],
  ["W", "command git push", "command builtin"],
  ["W", "exec git push", "exec"],
  ["W", "xargs -I{} git push {} < remotes.txt", "xargs"],
  ["W", "git push --force-with-lease", "control"],
  ["W", "timeout 600 terraform apply", "timeout wrapper"],
  ["W", "nice -n 10 ./deploy.sh", "nice with flags"],
  ["W", "watch -n 60 ./deploy.sh", "watch wrapper"],
  ["W", "git commit -am wip && git push", "chain"],
  ["W", "gh release create v1.2.3", "gh release"],
  ["W", "DRY_RUN=0 make -C infra deploy", "make -C"],
  ["Q", "git commit -m \"release notes\"", "quoted text"],
  ["Q:ro", "grep -r deploy src/", "read-only"],
  ["Q:ro", "cat deploy.yaml", "read-only"],
  ["Q:ro", "echo git push", "echo"],
  ["Q:ro", "ls deployments/", "no word boundary"],
  ["Q:ro", "git log --grep=release", "read-only git"],
  ["Q:ro", "# git push\\nls", "comment"],
  ["Q", "npm run predeploy-check", "predeploy"],
  ["W", "git -C \"$dir\" push", "quoted -C arg"],
  ["W", "git -c \"user.name=a b\" push", "quoted -c arg with space"],
  ["W", "git --git-dir=.git --work-tree=. push", "long options with ="],
  ["W", "ls;git push", "no space after ;"],
  ["W", "echo $(git push)", "command substitution"],
  ["W", "echo `git push`", "backticks"],
  ["W", "\\\\git push", "backslash-escaped command"],
  ["W", "/usr/bin/git push", "absolute path"],
  ["W", "g''it push", "empty quotes inside word"],
  ["W", "\"git\" \"push\"", "both quoted"],
  ["W", "$'git' push", "ANSI-C quoted"],
  ["W", "git \\\\\\npush", "line continuation"],
  ["W", "terraform -chdir=infra \\\\\\n  apply -auto-approve", "multi-line terraform"],
  ["W", "kubectl -n prod \\\\\\n  apply -f k8s/", "multi-line kubectl"],
  ["W", "sudo -u deploy git push", "sudo -u"],
  ["W", "nohup bash -c 'git push' &", "nohup + bash -c"],
  ["W", "bash -lc \"git push\"", "bash -lc"],
  ["W", "find . -maxdepth 0 -exec git push \\\\;", "find -exec"],
  ["W", "parallel git push ::: origin backup", "gnu parallel"],
  ["W", "git subtree push --prefix=dist origin gh-pages", "git subtree push"],
  ["W", "kubectl --kubeconfig=x -n y apply -k .", "two options before verb"],
  ["W", "if true; then git push; fi", "if/then"],
  ["W", "for r in a b; do git push $r; done", "for loop"],
  ["W", "while read r; do git push \"$r\"; done < remotes", "while loop"],
  ["W", "case x in x) git push;; esac", "case"],
  ["W", "f(){ git push; }; f", "function def + call"],
  ["W", "git push 2>&1 | tee push.log", "pipe to tee"],
  ["W", ">push.log git push", "leading redirect"],
  ["W", "2>/dev/null git push", "leading fd redirect"],
  ["W", "! git push", "negation"],
  ["W", "time -p git push", "time -p"],
  ["W", "command -p git push", "command -p"],
  ["W", "perl -e 'system(\"git push\")'", "perl -e"],
  ["W", "ruby -e 'system(\"git push\")'", "ruby -e"],
  ["W", "python3 - <<'PY'\\nimport subprocess; subprocess.run([\"git\",\"push\"])\\nPY", "python here-doc"],
  ["W", "exec 3>&1; git push", "exec redirect then push"],
  ["W", "coproc git push", "coproc"],
  ["Q", "git commit -m \"git push later\"", "quoted text 2"],
  ["Q:ro", "echo \"kubectl apply -f x\"", "echo quoted"],
  ["Q:ro", "grep -n 'terraform apply' README.md", "grep quoted"],
];
test('readonly.jq: stress corpus — no world-changing form reads as read-only; harmless reads stay read-only', () => {
  const bad = [];
  for (const [want, raw, note] of CORPUS) {
    // Expand escapes like printf %b: backslash-backslash, backslash-t, backslash-n (one left-to-right pass).
    const cmd = raw.replace(/\\(\\|t|n)/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : '\\'));
    const got = ro(cmd);
    if (want === 'W' && got) bad.push(`world-changing read as read-only: ${raw} (${note})`);
    if (want === 'Q:ro' && !got) bad.push(`read-only lost: ${raw} (${note}) — ${classify(cmd).why}`);
  }
  assert.deepEqual(bad, []);
});

test('the stress harnesses: round-1 and round-2 corpora (tests/stress/pulse-corpus*.sh)', () => {
  for (const f of ['pulse-corpus.sh', 'pulse-corpus2.sh']) {
    const r = spawnSync('bash', [path.join(SCRIPTS, '..', 'tests', 'stress', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\(MISS\): 0\/\d+ +read-only lost \(LOST\): 0\/\d+ +errors: 0/);
  }
});

function render(orient, showCosmetic = '0') {
  const r = spawnSync('jq', ['-r', '--arg', 'show_cosmetic', showCosmetic, '-f', path.join(SCRIPTS, 'retractions.jq')], { input: JSON.stringify(orient), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [cursor, seq, counts, integrity, ...lines] = r.stdout.replace(/\n$/, '').split('\n');
  const [shown, blocking, cosmetic] = counts.split(' ').map(Number);
  return { cursor, seq, shown, blocking, cosmetic, integrity, lines };
}
const R = (extra) => ({ seq: 7, event_type: 'block.superseded', kind: 'supersession', severity: 'behavioral', doc_slug: 'runbook', heading_path: ['Runbook', 'Deploy'], old_text: 'target: staging-a', new_text: 'target: staging-b', diff: 'target: [-staging-a-]{+staging-b+}', reason_line: 'x', ...extra });

test('retractions.jq: what you relied on, what it says now, the diff; removal; bare events', () => {
  const o = render({ cursor: 'sxt1.abc', head: { seq: 9 }, retractions: [R(), R({ seq: 8, kind: 'tombstone', severity: 'safety', new_text: null, diff: null }), R({ seq: 9, old_text: null, new_text: null, diff: null, reason_line: 'You previously relied on block b1; it is gone.' })] });
  assert.equal(o.cursor, 'sxt1.abc');
  assert.equal(o.seq, '9');
  assert.equal(o.shown, 3);
  assert.equal(o.blocking, 3);
  assert.match(o.lines[0], /^- runbook › Runbook › Deploy \(seq 7, supersession\/behavioral\): relied on "target: staging-a" → now "target: staging-b"; diff: target: \[-staging-a-\]\{\+staging-b\+\}$/);
  assert.match(o.lines[1], /now REMOVED$/);
  assert.match(o.lines[2], /You previously relied on block b1/);
});

test('retractions.jq: cosmetic flag (kronicle-lite next) — hidden by default, never blocking; absent flag = semantic', () => {
  const rs = [R(), R({ seq: 8, cosmetic: true }), R({ seq: 9, change_class: 'cosmetic' }), R({ seq: 10, semantic: false }), R({ seq: 11, change_class: 'semantic' }), R({ seq: 12, severity: 'informational' })];
  const o = render({ cursor: 'c', head: { seq: 12 }, retractions: rs });
  assert.equal(o.cosmetic, 3);
  assert.equal(o.shown, 3, 'semantic ones only');
  assert.equal(o.blocking, 2, 'informational never blocks');
  assert.ok(o.lines.every((l) => !/cosmetic/.test(l)));
  const all = render({ cursor: 'c', head: { seq: 12 }, retractions: rs }, '1');
  assert.equal(all.shown, 6);
  assert.equal(all.blocking, 2, 'shown cosmetic ones still never block');
  assert.equal(all.lines.filter((l) => /, cosmetic\)/.test(l)).length, 3);
});

test('retractions.jq: integrity line — "ok" unless integrity.ok === false (then seq and problem)', () => {
  assert.equal(render({ cursor: 'c', head: { seq: 3 }, retractions: [] }).integrity, 'ok', 'no integrity object (focus=pulse, older kl)');
  assert.equal(render({ cursor: 'c', head: { seq: 3 }, integrity: { ok: true, problem: null }, retractions: [] }).integrity, 'ok');
  assert.equal(render({ cursor: 'c', head: { seq: 3 }, integrity: { ok: false, seq: 2, problem: 'event 2: bad payload' }, retractions: [] }).integrity, 'fail\u001f2\u001fevent 2: bad payload');
  assert.equal(render({ cursor: 'c', head: { seq: 3 }, integrity: { ok: false }, retractions: [] }).integrity, 'fail\u001f?\u001fintegrity check failed');
});

test('retractions.jq: long lists and long text are bounded', () => {
  const big = 'x'.repeat(5000);
  const o = render({ cursor: 'c', head: { seq: 99 }, retractions: Array.from({ length: 20 }, (_, i) => R({ seq: i, old_text: big, new_text: big, diff: big })) });
  assert.equal(o.lines.length, 7);
  assert.match(o.lines[6], /and 14 more/);
  assert.ok(o.lines.every((l) => l.length < 700), 'each line is clipped');
});

// ── hook behaviour without the real CLI ──────────────────────────────────
const pre = (sb, command, extra = {}, sid = 'sess-unit-1') => hook('pulse.sh', { session_id: sid, cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, sb.env, extra);
const post = (sb, extra = {}, sid = 'sess-unit-1') => hook('post-tool-use.sh', { session_id: sid, cwd: sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: {} }, sb.env, extra);

test('push/pulse are inert when kronicle-lite is not configured: no output, no CLI lookup, an .off latch', () => {
  const sb = sandbox();
  try {
    assert.equal(post(sb).stdout, '');
    assert.equal(pre(sb, './bin/build && ./bin/deploy').stdout, '', 'nothing is gated without kronicle-lite');
    assert.ok(fs.existsSync(path.join(sb.run, 'push', 'sessunit.off')));
    assert.ok(!fs.existsSync(path.join(sb.run, 'log')) || !/push|pulse/.test(fs.readFileSync(path.join(sb.run, 'log'), 'utf8')));
  } finally { sb.cleanup(); }
});

test('push/pulse: configured but no CLI → off, logged once, allow', () => {
  const sb = sandbox();
  try {
    const env = { CC_ANCHOR_KRONICLE: '1', PATH: '/usr/bin:/bin', CC_ANCHOR_KRONICLE_LITE_BIN: '' };
    assert.equal(pre(sb, './bin/deploy', env).stdout, '');
    assert.equal(post(sb, env).stdout, '');
    const log = fs.readFileSync(path.join(sb.run, 'log'), 'utf8');
    assert.equal(log.match(/CLI was not found/g)?.length, 1);
  } finally { sb.cleanup(); }
});

test('push/pulse fail open: a hanging CLI is killed at push_timeout, the command is allowed, back-off holds, one log line', () => {
  const sb = sandbox();
  try {
    const fake = path.join(sb.base, 'kronicle-lite');
    fs.writeFileSync(fake, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });
    const env = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: fake, CC_ANCHOR_PUSH_TIMEOUT: '1' };
    let t0 = Date.now();
    const r = pre(sb, './bin/deploy --target x', env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'allowed (no decision)');
    assert.ok(Date.now() - t0 < 6000, `bounded: ${Date.now() - t0} ms`);
    t0 = Date.now();
    assert.equal(post(sb, env).stdout, '');
    assert.ok(Date.now() - t0 < 1500, 'inside the 60 s back-off the CLI is not called again');
    const log = fs.readFileSync(path.join(sb.run, 'log'), 'utf8');
    assert.equal(log.match(/timed out/g)?.length, 1);
  } finally { sb.cleanup(); }
});

test('push/pulse fail open: a CLI that crashes or prints garbage → allow, nothing on stdout', () => {
  const sb = sandbox();
  try {
    for (const body of ['echo boom >&2; exit 3', 'echo "not json"; exit 0']) {
      const fake = path.join(sb.base, 'kronicle-lite');
      fs.writeFileSync(fake, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      fs.rmSync(path.join(sb.run, 'push'), { recursive: true, force: true });
      const env = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: fake };
      for (const r of [post(sb, env), pre(sb, './bin/deploy', env), pre(sb, './bin/build && ./bin/deploy', env)]) {
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '', `${body}: ${r.stdout}`);
      }
    }
  } finally { sb.cleanup(); }
});

test('push=0 / pulse=0 switch the hooks off even when kronicle-lite is configured', () => {
  const sb = sandbox();
  try {
    const fake = path.join(sb.base, 'kronicle-lite');
    fs.writeFileSync(fake, `#!/usr/bin/env bash\necho called >> ${JSON.stringify(path.join(sb.base, 'calls'))}\nexit 1\n`, { mode: 0o755 });
    const env = { CC_ANCHOR_KRONICLE: '1', CC_ANCHOR_KRONICLE_LITE_BIN: fake };
    assert.equal(pre(sb, './bin/deploy', { ...env, CC_ANCHOR_PULSE: '0' }).stdout, '');
    assert.equal(post(sb, { ...env, CC_ANCHOR_PUSH: '0' }).stdout, '');
    assert.ok(!fs.existsSync(path.join(sb.base, 'calls')), 'the CLI was never run');
  } finally { sb.cleanup(); }
});

test('hooks.json registers the pulse on Bash and keeps the scope guard on edits', () => {
  const j = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'hooks', 'hooks.json'), 'utf8'));
  const pre = j.hooks.PreToolUse;
  assert.ok(pre.some((e) => e.matcher === 'Bash' && e.hooks.some((h) => /pulse\.sh/.test(h.args.join(' ')))));
  assert.ok(pre.some((e) => /Edit/.test(e.matcher) && e.hooks.some((h) => /pre-tool-use\.sh/.test(h.args.join(' ')))));
  for (const e of [...j.hooks.PostToolUse, ...pre]) for (const h of e.hooks) assert.ok(h.timeout >= 10, 'room for two bounded orient calls');
});

test('the kronicle-lite CLI is found in the npx cache (plugin-only installs launch the server with npx)', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.home, '.npm', '_npx', '0a1b2c', 'node_modules', 'kronicle-lite', 'dist');
    fs.mkdirSync(dir, { recursive: true });
    const calls = path.join(sb.base, 'calls');
    fs.writeFileSync(path.join(dir, 'cli.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); process.exit(1);\n`);
    fs.writeFileSync(path.join(dir, '..', 'package.json'), '{"name":"kronicle-lite","version":"0.6.0"}');
    // npm test puts node_modules/.bin (with a real kronicle-lite) on PATH; keep it out.
    const PATH = process.env.PATH.split(':').filter((d) => !d.includes('node_modules')).join(':');
    post(sb, { CC_ANCHOR_KRONICLE: '1', PATH });
    assert.match(fs.readFileSync(calls, 'utf8'), /^orient --json --actor cc-anchor-sessunit/m);
    assert.match(fs.readFileSync(path.join(sb.run, 'push', 'sessunit.cfg'), 'utf8'), /_npx\/0a1b2c\/node_modules\/kronicle-lite\/dist\/cli\.js/);
  } finally { sb.cleanup(); }
});
