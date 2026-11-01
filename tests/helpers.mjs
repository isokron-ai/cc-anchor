import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = path.join(ROOT, 'scripts');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

/** Fresh sandbox: a fake HOME and a fake project (with .git by default). */
export function sandbox({ git = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-anchor-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  if (git) fs.mkdirSync(path.join(proj, '.git'));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_PROJECT_DIR: proj,
    TZ: 'UTC',
    // Hooks that would background work (lease heartbeat, session document) run
    // it inline: nothing may still be writing under HOME when a test cleans up.
    CC_ANCHOR_SYNC: '1',
  };
  const card = path.join(proj, '.claude', 'anchor.md');
  const run = path.join(proj, '.claude', 'cc-anchor');
  return {
    base,
    home,
    proj,
    env,
    card,
    run,
    trail: path.join(run, 'trail.jsonl'),
    state: path.join(run, 'state.json'),
    cursorFile: path.join(run, 'cursor'),
    readCard: () => fs.readFileSync(card, 'utf8'),
    readState: () => JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8')),
    writeState: (obj) => { fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'state.json'), JSON.stringify(obj)); },
    trailLines: () => (fs.existsSync(path.join(run, 'trail.jsonl')) ? fs.readFileSync(path.join(run, 'trail.jsonl'), 'utf8').split('\n').filter(Boolean) : []),
    // Background hooks (lease heartbeat, session doc) may still be writing under
    // HOME when a test ends (slower macOS runners): retry instead of ENOTEMPTY.
    cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export function fixture(name, patch = {}) {
  return { ...JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')), ...patch };
}

/** Run a hook script with a JSON payload on stdin. */
export function hook(name, payload, env, extraEnv = {}, bash = 'bash') {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(bash, [path.join(SCRIPTS, name)], { input, encoding: 'utf8', env: { ...env, ...extraEnv } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parseJsonMaybe(r.stdout) };
}

export function parseJsonMaybe(s) {
  const t = (s || '').trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** Run the CLI. */
export function cli(args, env, extraEnv = {}) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'anchor.mjs'), ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function postTool(env, tool, tool_input, extra = {}) {
  return hook('post-tool-use.sh', {
    session_id: 'abc123',
    cwd: env.CLAUDE_PROJECT_DIR,
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input,
    tool_response: {},
    tool_use_id: 'toolu_test',
    ...extra,
  }, env);
}

export const isoMinutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
