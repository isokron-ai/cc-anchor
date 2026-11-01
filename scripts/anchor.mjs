#!/usr/bin/env node
/**
 * cc-anchor CLI — the hand-edit surface behind `/cc-anchor:anchor`.
 *
 *   anchor.mjs show [--json]                 print the card (+ status)
 *   anchor.mjs init                          create a card if none exists
 *   anchor.mjs set goal <text>               update the Goal line
 *   anchor.mjs set project <text>            update the Project line
 *   anchor.mjs add-invariant <text>          append "- never …"
 *   anchor.mjs rm-invariant <n|text>         remove by 1-based index or text
 *   anchor.mjs refresh                       stamp refreshed_at (drift → 0)
 *   anchor.mjs cursor                        print detected cursor + kronicle status
 *   anchor.mjs statusline install [--force|--append] [--scope user|project]
 *   anchor.mjs statusline snippet | uninstall
 *   anchor.mjs doctor [--probe]              paths, deps, hooks, kronicle, sea-lite, config
 *   anchor.mjs render                        regenerate the trail section
 *   anchor.mjs paths [--json]                resolved file locations
 *   anchor.mjs config [show|set K V|unset K] [--scope project|user]   lifecycle-pack switches
 *   anchor.mjs claims [--json]               live sea-lite claims + pending releases
 *   anchor.mjs hooks install|uninstall orient-mcp --server NAME [--scope]   optional mcp_tool orient hook
 *   anchor.mjs hooks install|uninstall worktree [--scope]                   WorktreeCreate/Remove pack
 *   anchor.mjs cursor install|uninstall [--scope project|user]            Cursor hooks.json port
 *
 * No runtime dependencies. Node >= 18. The card format and the trail
 * renderer live in scripts/lib.sh (one renderer, shared with the hooks);
 * this file only edits the hand-written top section and shells out to
 * `cc_render` for everything below the marker.
 *
 * Root resolution: --root PATH > $CLAUDE_PROJECT_DIR > process.cwd().
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_SH = path.join(__dirname, 'lib.sh');
const STATUSLINE_SH = path.join(__dirname, 'statusline.sh');
const RENDER_JQ = path.join(__dirname, 'render.jq');
const CURSOR_DIR = path.join(__dirname, '..', 'cursor');
/** Files the hook scripts need next to lib.sh when copied out of the plugin. */
const SHELL_RUNTIME = ['lib.sh', 'render.jq', 'claims.jq'];

export const MARKER = '<!-- cc-anchor:trail -->';
export const VERSION_LINE =
  '<!-- cc-anchor v1 — edit the lines above the trail marker by hand or with /cc-anchor:anchor. Everything below the marker is regenerated. -->';
export const MAX_LINES = 25;
export const MAX_INVARIANTS = 8;
export const CURSOR_RE = /^sxt1c?\.[A-Za-z0-9_.-]+$/;

const UNSET = {
  project: '(unset — /cc-anchor:anchor set project "one line")',
  goal: '(unset — /cc-anchor:anchor set goal "what we are doing right now")',
  invariant: '(none — /cc-anchor:anchor add-invariant "never …")',
};

// ───────────────────────────── paths ─────────────────────────────

function sha1_12(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** Mirror of cc_resolve in lib.sh. */
export function resolvePaths(rootArg, env = process.env) {
  const root = path.resolve(rootArg || env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\/+$/, '');
  const home = env.HOME || os.homedir();
  let dir;
  let run;
  let where;
  if (env.CC_ANCHOR_DIR) {
    dir = env.CC_ANCHOR_DIR.replace(/\/+$/, '');
    run = path.join(dir, 'cc-anchor');
    where = 'env';
  } else if (env.CC_ANCHOR_HOME !== '1' && (fs.existsSync(path.join(root, '.claude')) || fs.existsSync(path.join(root, '.git')))) {
    dir = path.join(root, '.claude');
    run = path.join(dir, 'cc-anchor');
    where = 'project';
  } else {
    dir = path.join(home, '.claude', 'cc-anchor', sha1_12(root));
    run = dir;
    where = 'home';
  }
  return {
    root,
    dir,
    run,
    where,
    card: path.join(dir, 'anchor.md'),
    trail: path.join(run, 'trail.jsonl'),
    state: path.join(run, 'state.json'),
    cursorFile: path.join(run, 'cursor'),
    config: path.join(dir, 'cc-anchor.json'),
    configHome: path.join(home, '.claude', 'cc-anchor', 'config.json'),
    claims: path.join(run, 'claims.json'),
    pending: path.join(run, 'pending-release.jsonl'),
    log: path.join(run, 'log'),
  };
}

// ───────────────────────────── config (lifecycle pack switches) ─────────────────────────────

/** Every switch the hooks read, with its default and the hook that honours it. */
export const CONFIG_KEYS = {
  claim_guard: { default: false, hook: 'Stop', doc: 'block the stop once while a sea-lite claim is live (needs sea-lite)' },
  session_doc: { default: false, hook: 'Stop', doc: 'put_document session-<date>-<id> (card + last message) via the kronicle-lite CLI' },
  subagent_release: { default: 'auto', hook: 'SubagentStop', doc: 'block the subagent once + queue pending releases for its claims (auto = when sea-lite is configured)' },
  task_mirror: { default: false, hook: 'TaskCreated/TaskCompleted', doc: 'mirror Claude Code tasks into sea-lite tickets (idempotency key cc-task:<id>)' },
  task_mirror_gate: { default: true, hook: 'TaskCompleted', doc: 'with task_mirror: block completion while the ticket has open predecessors' },
  scope_guard: { default: false, hook: 'PreToolUse', doc: 'deny Edit/Write inside someone else\'s live sea-lite claim (another actor, or this actor in another session; needs sea-lite >= 0.4.0)' },
  scope_ttl: { default: 30, hook: 'PreToolUse', doc: 'seconds a scope verdict is cached per session and path' },
  scope_timeout: { default: 4, hook: 'PreToolUse', doc: 'seconds to wait for sea-lite scope-check before failing open' },
  heartbeat: { default: 'auto', hook: 'PostToolUse', doc: 'renew this session\'s sea-lite leases in the background (auto = when claims were seen or sea-lite is configured)' },
  heartbeat_interval: { default: 60, hook: 'PostToolUse', doc: 'minimum seconds between two lease heartbeats per session' },
  sea_session: { default: '', hook: 'PreToolUse/PostToolUse', doc: 'session to act as instead of the hook\'s session_id (Cursor: the --session your sea-lite server runs with)' },
  sea_actor: { default: '', hook: 'PreToolUse/PostToolUse', doc: 'pass --actor to sea-lite (default: the session\'s own server actor; every claim of the session counts as yours)' },
  push: { default: 'auto', hook: 'PostToolUse', doc: 'inject kronicle-lite retractions that landed since the last tool call (auto = when kronicle-lite is configured)' },
  push_timeout: { default: 3, hook: 'PostToolUse/PreToolUse', doc: 'seconds per kronicle-lite orient call before the push/pulse fails open' },
  push_cosmetic: { default: false, hook: 'PostToolUse/PreToolUse', doc: 'also show retractions kronicle-lite marks cosmetic (they never block)' },
  pulse: { default: 'auto', hook: 'PreToolUse (Bash)', doc: 'check retractions before world-changing Bash commands (auto = with the push)' },
  pulse_match: { default: 'deploy|migrate|publish|release|git push|terraform apply|kubectl apply', hook: 'PreToolUse (Bash)', doc: 'regex for world-changing commands (word boundaries added; quoted text ignored)' },
  pulse_mode: { default: 'deny', hook: 'PreToolUse (Bash)', doc: 'deny | warn when an unreconciled semantic retraction exists' },
  pulse_chain: { default: 'split', hook: 'PreToolUse (Bash)', doc: 'split = deny a call that runs a world-changing step after other steps (run it on its own); check = allow' },
  kronicle_data_dir: { default: '', hook: 'PostToolUse/PreToolUse', doc: 'kronicle-lite store the push reads (default: the kronicle MCP server\'s --data-dir, else $KRONICLE_LITE_DATA_DIR, else ~/.kronicle-lite)' },
};

export function readConfig(p) {
  const home = readJson(p.configHome, {});
  const proj = readJson(p.config, {});
  const out = {};
  for (const k of Object.keys(CONFIG_KEYS)) {
    const envName = `CC_ANCHOR_${k.toUpperCase()}`;
    if (process.env[envName] !== undefined && process.env[envName] !== '') out[k] = { value: process.env[envName], via: 'env' };
    else if (proj[k] !== undefined) out[k] = { value: proj[k], via: p.config };
    else if (home[k] !== undefined) out[k] = { value: home[k], via: p.configHome };
    else out[k] = { value: CONFIG_KEYS[k].default, via: 'default' };
  }
  return out;
}

function coerce(v) {
  if (/^(true|1|yes|on)$/i.test(v)) return true;
  if (/^(false|0|no|off)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function cmdConfig(p, rest, flags) {
  const [sub = 'show', key, ...valParts] = rest;
  const file = flags.scope === 'user' ? p.configHome : p.config;
  if (sub === 'show') {
    const c = readConfig(p);
    if (flags.json) return console.log(JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.value])), null, 2));
    console.log(`config files: ${p.config} (project) · ${p.configHome} (user) · env CC_ANCHOR_<KEY> wins`);
    for (const [k, v] of Object.entries(c)) console.log(`${k.padEnd(18)} ${String(v.value).padEnd(6)} ${v.via === 'default' ? '(default)' : `← ${v.via}`}   ${CONFIG_KEYS[k].doc}`);
    return;
  }
  if (!key || !(key in CONFIG_KEYS)) throw new Error(`usage: config set|unset <${Object.keys(CONFIG_KEYS).join('|')}> [value] [--scope project|user]`);
  const cur = readJson(file, {});
  if (sub === 'set') {
    const raw = valParts.join(' ');
    if (!raw) throw new Error(`usage: config set ${key} <value>`);
    cur[key] = coerce(raw);
  } else if (sub === 'unset') {
    delete cur[key];
  } else throw new Error('usage: config [show|set K V|unset K]');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  console.log(`${key} ${sub === 'set' ? `= ${JSON.stringify(cur[key])}` : 'unset'} in ${file}`);
}

// ───────────────────────────── sea-lite / claims ─────────────────────────────

export function seaConfigured(p, env = process.env) {
  if (env.CC_ANCHOR_SEA === '1') return { configured: true, via: 'env' };
  if (env.CC_ANCHOR_SEA === '0') return { configured: false, via: 'env' };
  const home = env.HOME || os.homedir();
  const hit = (s) => /sea[-_]lite/i.test(String(s));
  const serversHit = (servers) => Object.entries(servers || {}).some(([k, v]) => hit(k) || hit(v?.command || '') || (v?.args || []).some(hit));
  for (const f of [path.join(p.root, '.mcp.json'), path.join(home, '.claude.json')]) {
    const j = readJson(f, null);
    if (j && (serversHit(j.mcpServers) || serversHit(j.projects?.[p.root]?.mcpServers))) return { configured: true, via: f };
  }
  for (const f of [path.join(home, '.claude', 'settings.json'), path.join(p.root, '.claude', 'settings.json'), path.join(p.root, '.claude', 'settings.local.json')]) {
    const j = readJson(f, null);
    if (j && Object.entries(j.enabledPlugins || {}).some(([k, v]) => /^sea[-_]lite/i.test(k) && v === true)) return { configured: true, via: f };
  }
  return { configured: false, via: null };
}

/** Where the kronicle-lite / sea-lite CLI would be run from (mirror of lib.sh::cc_find_cli). */
export function findCli(name, env = process.env) {
  const envName = `CC_ANCHOR_${name.toUpperCase().replace(/-/g, '_')}_BIN`;
  if (env[envName]) return env[envName];
  const onPath = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8', env }).stdout.trim();
  if (onPath) return onPath;
  const home = env.HOME || os.homedir();
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  const dirs = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const mk of dirs(cache)) for (const plug of dirs(path.join(cache, mk))) for (const ver of dirs(path.join(cache, mk, plug))) {
    const f = path.join(cache, mk, plug, ver, 'node_modules', name, 'dist', 'cli.js');
    if (fs.existsSync(f)) return f;
  }
  const npx = path.join(env.npm_config_cache || path.join(home, '.npm'), '_npx');
  for (const h of dirs(npx)) {
    const f = path.join(npx, h, 'node_modules', name, 'dist', 'cli.js');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function liveClaims(p) {
  const j = readJson(p.claims, { claims: {} });
  const now = nowIso();
  return Object.entries(j.claims || {}).map(([ticket_id, v]) => ({ ticket_id, ...v })).filter((c) => (c.expires || '') > now);
}
function pendingReleases(p) {
  if (!fs.existsSync(p.pending)) return [];
  const live = new Set(liveClaims(p).map((c) => c.ticket_id));
  return fs.readFileSync(p.pending, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && live.has(e.ticket_id));
}

function cmdClaims(p, flags) {
  const live = liveClaims(p);
  const pending = pendingReleases(p);
  if (flags.json) return console.log(JSON.stringify({ live, pending }, null, 2));
  if (!live.length) return console.log('no live sea-lite claims recorded (claims.json is filled from sea_claim / sea_next / sea_create results seen by the PostToolUse hook)');
  for (const c of live) console.log(`${c.ticket_id}  held by ${c.agent ? `subagent ${c.agent}` : 'main agent'}  via ${c.via}  expires ${c.expires}${pending.some((e) => e.ticket_id === c.ticket_id) ? '  [PENDING RELEASE]' : ''}`);
}

// ───────────────────────────── hook packs (settings.json) ─────────────────────────────

const PACK_TAG = 'cc-anchor-pack';

function installRuntimeCopy(env = process.env) {
  const home = env.HOME || os.homedir();
  const installDir = path.join(home, '.claude', 'cc-anchor');
  fs.mkdirSync(installDir, { recursive: true });
  for (const f of [...SHELL_RUNTIME, 'worktree-create.sh', 'worktree-remove.sh']) {
    const dst = path.join(installDir, f);
    fs.copyFileSync(path.join(__dirname, f), dst);
    fs.chmodSync(dst, 0o755);
  }
  return installDir;
}

/**
 * The optional `type: "mcp_tool"` orient hook, exactly per the hooks
 * reference "MCP tool hook fields": {server, tool, input}. Matcher is
 * compact|clear because the reference says SessionStart at launch fires
 * before MCP servers exist and skips mcp_tool hooks. No since_cursor: the
 * `input` field can only template ${fields} of the hook's own JSON input,
 * and the cursor is on disk, not in the SessionStart payload.
 */
export function orientMcpHook(server) {
  return {
    SessionStart: [{
      matcher: 'compact|clear',
      hooks: [{ type: 'mcp_tool', server, tool: 'get_system_state', input: { focus: 'orientation', budget_tokens: 1500 }, timeout: 30, statusMessage: 'cc-anchor: orienting against kronicle-lite' }],
    }],
  };
}

export function worktreePackHooks(installDir) {
  return {
    WorktreeCreate: [{ hooks: [{ type: 'command', command: 'bash', args: [path.join(installDir, 'worktree-create.sh')], timeout: 60 }] }],
    WorktreeRemove: [{ hooks: [{ type: 'command', command: 'bash', args: [path.join(installDir, 'worktree-remove.sh')], timeout: 60 }] }],
  };
}

function tagGroups(hooksObj, pack) {
  for (const groups of Object.values(hooksObj)) for (const g of groups) g[PACK_TAG] = pack;
  return hooksObj;
}

export function hooksInstall(p, pack, { scope = 'user', server, env = process.env } = {}) {
  let add;
  if (pack === 'orient-mcp') {
    if (!server) throw new Error('hooks install orient-mcp needs --server <mcp server name> (bare key for a user/project server, "plugin:kronicle-lite:kronicle-lite" for the plugin-bundled one)');
    add = orientMcpHook(server);
  } else if (pack === 'worktree') {
    add = worktreePackHooks(installRuntimeCopy(env));
  } else throw new Error('packs: orient-mcp, worktree');
  const sp = settingsPath(scope, p, env);
  const settings = readJson(sp, {});
  settings.hooks = settings.hooks || {};
  for (const [ev, groups] of Object.entries(tagGroups(add, pack))) {
    settings.hooks[ev] = (settings.hooks[ev] || []).filter((g) => g[PACK_TAG] !== pack).concat(groups);
  }
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
  return { settings: sp, events: Object.keys(add) };
}

export function hooksUninstall(p, pack, { scope = 'user', env = process.env } = {}) {
  const sp = settingsPath(scope, p, env);
  const settings = readJson(sp, {});
  let removed = 0;
  for (const ev of Object.keys(settings.hooks || {})) {
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter((g) => g[PACK_TAG] !== pack);
    removed += before - settings.hooks[ev].length;
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
  return { settings: sp, removed };
}

// ───────────────────────────── Cursor port ─────────────────────────────

const CURSOR_EVENTS = ['sessionStart', 'preCompact', 'postToolUse', 'preToolUse', 'stop', 'subagentStop'];

export function cursorInstall(p, { scope = 'project', env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  const base = scope === 'user' ? path.join(home, '.cursor') : path.join(p.root, '.cursor');
  const dest = path.join(base, 'hooks', 'cc-anchor');
  fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(CURSOR_DIR, 'adapter.sh'), path.join(dest, 'adapter.sh'));
  fs.chmodSync(path.join(dest, 'adapter.sh'), 0o755);
  for (const f of fs.readdirSync(__dirname)) {
    if (!/\.(sh|jq|mjs)$/.test(f)) continue;
    fs.copyFileSync(path.join(__dirname, f), path.join(dest, 'scripts', f));
    fs.chmodSync(path.join(dest, 'scripts', f), 0o755);
  }
  // Project hooks run from the project root; user hooks from ~/.cursor/ (Cursor docs).
  const rel = scope === 'user' ? './hooks/cc-anchor/adapter.sh' : '.cursor/hooks/cc-anchor/adapter.sh';
  const template = readJson(path.join(CURSOR_DIR, 'hooks.json'), { version: 1, hooks: {} });
  const hf = path.join(base, 'hooks.json');
  const existing = readJson(hf, { version: 1, hooks: {} });
  existing.version = existing.version || 1;
  existing.hooks = existing.hooks || {};
  for (const ev of CURSOR_EVENTS) {
    const mine = (template.hooks[ev] || []).map((h) => ({ ...h, command: `bash ${rel} ${ev}` }));
    existing.hooks[ev] = (existing.hooks[ev] || []).filter((h) => !/cc-anchor\/adapter\.sh/.test(h.command || '')).concat(mine);
  }
  fs.writeFileSync(hf, JSON.stringify(existing, null, 2) + '\n');
  return { hooksFile: hf, dest, events: CURSOR_EVENTS };
}

export function cursorUninstall(p, { scope = 'project', env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  const base = scope === 'user' ? path.join(home, '.cursor') : path.join(p.root, '.cursor');
  const hf = path.join(base, 'hooks.json');
  const existing = readJson(hf, null);
  if (existing?.hooks) {
    for (const ev of Object.keys(existing.hooks)) {
      existing.hooks[ev] = existing.hooks[ev].filter((h) => !/cc-anchor\/adapter\.sh/.test(h.command || ''));
      if (!existing.hooks[ev].length) delete existing.hooks[ev];
    }
    fs.writeFileSync(hf, JSON.stringify(existing, null, 2) + '\n');
  }
  fs.rmSync(path.join(base, 'hooks', 'cc-anchor'), { recursive: true, force: true });
  return { hooksFile: hf };
}

// ───────────────────────────── card parse / render ─────────────────────────────

/**
 * Parse a card into {title, project, goal, invariants[], extraTop[], trail[],
 * cursor, compacted, refreshed, topLines[]}. Tolerant: unknown lines in the
 * top section are kept verbatim in `extraTop` and re-emitted by renderTop so a
 * hand-edited card round-trips byte-for-byte.
 */
export function parseCard(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const mi = lines.indexOf(MARKER);
  const top = mi === -1 ? lines : lines.slice(0, mi);
  const gen = mi === -1 ? [] : lines.slice(mi + 1);

  const out = {
    title: null,
    project: null,
    goal: null,
    invariants: [],
    extraTop: [],
    topLines: top.slice(),
    trail: [],
    cursor: null,
    compacted: null,
    refreshed: null,
    hasMarker: mi !== -1,
  };
  let inInv = false;
  for (const line of top) {
    if (out.title === null && /^# /.test(line)) { out.title = line.slice(2).trim(); continue; }
    if (line === VERSION_LINE) continue;
    if (/^Project:/.test(line)) { out.project = line.replace(/^Project:\s*/, ''); inInv = false; continue; }
    if (/^Goal:/.test(line)) { out.goal = line.replace(/^Goal:\s*/, ''); inInv = false; continue; }
    if (/^Invariants:\s*$/.test(line)) { inInv = true; continue; }
    if (inInv && /^- /.test(line)) {
      const v = line.slice(2).trim();
      if (!v.startsWith('(none')) out.invariants.push(v);
      continue;
    }
    if (line.trim() === '') continue;
    inInv = false;
    out.extraTop.push(line);
  }
  for (const line of gen) {
    const m = /^- (\S+) (\S+) ?(.*)$/.exec(line);
    if (/^- \d{4}-\d{2}-\d{2}T/.test(line) && m) { out.trail.push({ ts: m[1], tool: m[2], target: m[3] }); continue; }
    if (/^Cursor:\s*/.test(line)) { out.cursor = line.replace(/^Cursor:\s*/, '').trim(); continue; }
    if (/^Compacted:\s*/.test(line)) { const v = line.replace(/^Compacted:\s*/, '').trim(); out.compacted = v === 'never' ? null : v; continue; }
    if (/^Refreshed:\s*/.test(line)) { const v = line.replace(/^Refreshed:\s*/, '').trim(); out.refreshed = v === 'never' ? null : v; continue; }
  }
  return out;
}

/** Render only the hand-edited top section (what the CLI owns). */
export function renderTop({ title, project, goal, invariants = [], extraTop = [] }) {
  const inv = invariants.length ? invariants.map((v) => `- ${v}`) : [`- ${UNSET.invariant}`];
  return [
    `# ${title || 'ANCHOR'}`,
    VERSION_LINE,
    `Project: ${project || UNSET.project}`,
    `Goal: ${goal || UNSET.goal}`,
    ...extraTop,
    'Invariants:',
    ...inv,
  ].join('\n') + '\n';
}

function oneLine(s) {
  return String(s).replace(/\s*\n\s*/g, ' ').trim();
}

// ───────────────────────────── shell bridge to lib.sh ─────────────────────────────

function sh(fn, p, extraEnv = {}) {
  const r = spawnSync('bash', ['-c', `. "$1" && cc_resolve "$2" && ${fn}`, 'cc-anchor', LIB_SH, p.root], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) throw new Error(`lib.sh ${fn} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Regenerate the trail section through the single renderer in lib.sh. */
export function render(p) {
  sh('cc_render', p);
}

function readState(p) {
  try { return JSON.parse(fs.readFileSync(p.state, 'utf8')); } catch { return {}; }
}
function writeState(p, patch) {
  fs.mkdirSync(p.run, { recursive: true });
  const next = { ...readState(p), ...patch };
  const tmp = `${p.state}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, p.state);
  return next;
}
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function readCard(p) {
  if (!fs.existsSync(p.card)) return null;
  return parseCard(fs.readFileSync(p.card, 'utf8'));
}

/** Write a new top section (verbatim), keep generated part, re-render. */
function writeTop(p, fields) {
  fs.mkdirSync(p.dir, { recursive: true });
  const existing = fs.existsSync(p.card) ? fs.readFileSync(p.card, 'utf8') : '';
  const mi = existing.indexOf(MARKER);
  const gen = mi === -1 ? '' : existing.slice(mi);
  const tmp = `${p.card}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderTop(fields) + gen);
  fs.renameSync(tmp, p.card);
  writeState(p, { refreshed_at: nowIso(), top_hash: null });
  render(p);
}

function ensureCard(p) {
  let c = readCard(p);
  if (!c) {
    writeTop(p, { title: `ANCHOR — ${path.basename(p.root)}`, project: null, goal: null, invariants: [] });
    c = readCard(p);
  }
  return c;
}

// ───────────────────────────── cursor / kronicle ─────────────────────────────

export function detectCursor(p) {
  const candidates = [
    p.cursorFile,
    path.join(p.root, '.cc-anchor-cursor'),
    path.join(p.root, '.sextant-cursor'),
    path.join(p.root, '.kronicle-cursor'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let tok = '';
    if (raw.trimStart().startsWith('{')) {
      try { const j = JSON.parse(raw); tok = j.cursor_token || j.cursor_compact || j.cursor || ''; } catch { tok = ''; }
    } else {
      tok = raw.split('\n')[0].trim();
    }
    if (tok && CURSOR_RE.test(tok)) return { cursor: tok, source: f };
  }
  return null;
}

export function kronicleConfigured(p, env = process.env) {
  if (env.CC_ANCHOR_KRONICLE === '1') return { configured: true, via: 'env' };
  if (env.CC_ANCHOR_KRONICLE === '0') return { configured: false, via: 'env' };
  const home = env.HOME || os.homedir();
  const hit = (s) => String(s).toLowerCase().includes('kronicle');
  const serversHit = (servers) =>
    Object.entries(servers || {}).some(([k, v]) => hit(k) || hit(v?.command || '') || (v?.args || []).some(hit));
  for (const f of [path.join(p.root, '.mcp.json'), path.join(home, '.claude.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (serversHit(j.mcpServers) || serversHit(j.projects?.[p.root]?.mcpServers)) return { configured: true, via: f };
    } catch { /* absent or unreadable */ }
  }
  for (const f of [
    path.join(home, '.claude', 'settings.json'),
    path.join(p.root, '.claude', 'settings.json'),
    path.join(p.root, '.claude', 'settings.local.json'),
  ]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Object.entries(j.enabledPlugins || {}).some(([k, v]) => /^kronicle/i.test(k) && v === true)) return { configured: true, via: f };
    } catch { /* ignore */ }
  }
  return { configured: false, via: null };
}

/** Slow path: ask the CLI. Only used by `doctor --probe`. */
function probeMcpList() {
  const r = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 20000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, kronicle: /kronicle/i.test(out), raw: out.trim() };
}

// ───────────────────────────── statusline install ─────────────────────────────

function settingsPath(scope, p, env = process.env) {
  const home = env.HOME || os.homedir();
  return scope === 'project' ? path.join(p.root, '.claude', 'settings.json') : path.join(home, '.claude', 'settings.json');
}

export function statuslineSnippet(cmd = '~/.claude/cc-anchor/statusline.sh') {
  return { statusLine: { type: 'command', command: cmd, padding: 1, refreshInterval: 60 } };
}

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}

export function statuslineInstall(p, { force = false, append = false, scope = 'user', env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  const installDir = path.join(home, '.claude', 'cc-anchor');
  fs.mkdirSync(installDir, { recursive: true });
  for (const f of [STATUSLINE_SH, LIB_SH, RENDER_JQ, ...SHELL_RUNTIME.map((n) => path.join(__dirname, n))]) {
    const dst = path.join(installDir, path.basename(f));
    fs.copyFileSync(f, dst);
    fs.chmodSync(dst, 0o755);
  }
  const ours = path.join(installDir, 'statusline.sh');
  const sp = settingsPath(scope, p, env);
  const settings = readJson(sp, {});
  const existing = settings.statusLine;
  const isOurs = existing && typeof existing.command === 'string' && /cc-anchor\/statusline/.test(existing.command);

  let command = ours;
  if (existing && !isOurs) {
    if (append) {
      const wrapper = path.join(installDir, 'statusline-wrapper.sh');
      const prevCmd = existing.type === 'command' && typeof existing.command === 'string' ? existing.command : '';
      fs.writeFileSync(
        wrapper,
        `#!/usr/bin/env bash\n# cc-anchor wrapper: previous status line, then the anchor segment on a second row.\ninput="$(cat)"\n` +
          (prevCmd ? `printf '%s' "$input" | ${prevCmd}\n` : '') +
          `printf '%s' "$input" | "${ours}"\n`,
      );
      fs.chmodSync(wrapper, 0o755);
      fs.writeFileSync(path.join(installDir, 'statusline-previous.json'), JSON.stringify(existing, null, 2) + '\n');
      command = wrapper;
    } else if (force) {
      fs.writeFileSync(path.join(installDir, 'statusline-previous.json'), JSON.stringify(existing, null, 2) + '\n');
    } else {
      const err = new Error(
        `A statusLine is already configured in ${sp}:\n${JSON.stringify(existing, null, 2)}\n` +
          'Re-run with --append to keep it (anchor on a second row) or --force to replace it.',
      );
      err.code = 'EXISTS';
      throw err;
    }
  }
  settings.statusLine = { type: 'command', command, padding: existing?.padding ?? 1, refreshInterval: existing?.refreshInterval ?? 60 };
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
  return { settings: sp, command, replaced: !!(existing && !isOurs && force), appended: !!(existing && !isOurs && append) };
}

export function statuslineUninstall(p, { scope = 'user', env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  const installDir = path.join(home, '.claude', 'cc-anchor');
  const sp = settingsPath(scope, p, env);
  const settings = readJson(sp, {});
  const prevFile = path.join(installDir, 'statusline-previous.json');
  const prev = readJson(prevFile, null);
  if (prev) { settings.statusLine = prev; fs.rmSync(prevFile, { force: true }); } else { delete settings.statusLine; }
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
  return { settings: sp, restored: !!prev };
}

// ───────────────────────────── commands ─────────────────────────────

function status(p) {
  const st = readState(p);
  const trail = fs.existsSync(p.trail) ? fs.readFileSync(p.trail, 'utf8').split('\n').filter(Boolean) : [];
  let since = trail.length;
  if (st.compacted_at) since = trail.filter((l) => { try { return JSON.parse(l).ts > st.compacted_at; } catch { return false; } }).length;
  const drift = st.refreshed_at ? Math.floor((Date.now() - Date.parse(st.refreshed_at)) / 60000) : null;
  return { where: p.where, card: p.card, trail_entries: trail.length, since_compact: since, drift_minutes: drift, compacted_at: st.compacted_at || null, compact_count: Number(st.compact_count || 0), refreshed_at: st.refreshed_at || null };
}

function cmdShow(p, flags) {
  const c = readCard(p);
  if (!c) {
    if (flags.json) return console.log(JSON.stringify({ card: null, ...status(p) }, null, 2));
    console.log(`No anchor card yet (${p.card}).\nCreate one: /cc-anchor:anchor set goal "…"  — or: node anchor.mjs init`);
    return;
  }
  render(p);
  const text = fs.readFileSync(p.card, 'utf8');
  if (flags.json) return console.log(JSON.stringify({ card: parseCard(text), raw: text, ...status(p) }, null, 2));
  process.stdout.write(text);
  const s = status(p);
  const n = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
  console.log(`\n[cc-anchor] ${p.where} store · ${n}/${MAX_LINES} lines · ${s.since_compact} tool calls since compact · drift ${s.drift_minutes === null ? 'never refreshed' : s.drift_minutes + 'm'} · compactions ${s.compact_count}`);
  if (n > MAX_LINES) console.log(`[cc-anchor] WARNING: card exceeds ${MAX_LINES} lines; trim the hand-edited section so it survives verbatim.`);
}

function cmdSet(p, what, text) {
  if (!['goal', 'project'].includes(what)) throw new Error('usage: set goal|project <text>');
  if (!text) throw new Error(`usage: set ${what} <text>`);
  const c = ensureCard(p);
  c[what] = oneLine(text);
  writeTop(p, c);
  console.log(`${what} set: ${c[what]}`);
}

function cmdAddInvariant(p, text) {
  if (!text) throw new Error('usage: add-invariant <text>');
  const c = ensureCard(p);
  const v = oneLine(text);
  if (c.invariants.includes(v)) return console.log('invariant already present');
  if (c.invariants.length >= MAX_INVARIANTS) throw new Error(`max ${MAX_INVARIANTS} invariants (keep the card under ${MAX_LINES} lines); remove one first`);
  c.invariants.push(v);
  writeTop(p, c);
  console.log(`invariant added (${c.invariants.length}): ${v}`);
}

function cmdRmInvariant(p, key) {
  if (!key) throw new Error('usage: rm-invariant <n|text>');
  const c = ensureCard(p);
  let idx = /^\d+$/.test(key) ? Number(key) - 1 : c.invariants.findIndex((v) => v === key || v.includes(key));
  if (idx < 0 || idx >= c.invariants.length) throw new Error(`no invariant matches "${key}"`);
  const [gone] = c.invariants.splice(idx, 1);
  writeTop(p, c);
  console.log(`invariant removed: ${gone}`);
}

function cmdRefresh(p) {
  ensureCard(p);
  writeState(p, { refreshed_at: nowIso() });
  render(p);
  console.log('anchor refreshed (drift reset to 0m)');
}

function cmdCursor(p, flags) {
  const cur = detectCursor(p);
  const k = kronicleConfigured(p);
  const out = { cursor: cur?.cursor || null, source: cur?.source || null, kronicle_configured: k.configured, kronicle_via: k.via };
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  console.log(cur ? `cursor: ${cur.cursor}\nsource: ${cur.source}` : 'cursor: none found (.cc-anchor-cursor / .sextant-cursor / .kronicle-cursor)');
  console.log(`kronicle-lite configured: ${k.configured}${k.via ? ` (${k.via})` : ''}`);
  if (k.configured && cur) console.log(`after compaction the hook will add: call get_system_state with since_cursor=${cur.cursor}`);
}

function cmdDoctor(p, flags) {
  const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
  const hooks = readJson(path.join(__dirname, '..', 'hooks', 'hooks.json'), {});
  const events = Object.keys(hooks.hooks || {});
  const k = kronicleConfigured(p);
  const sea = seaConfigured(p);
  const cfg = readConfig(p);
  const cur = detectCursor(p);
  const rows = [
    ['root', p.root],
    ['store', `${p.where} → ${p.dir}`],
    ['card', `${p.card} ${fs.existsSync(p.card) ? '(present)' : '(missing)'}`],
    ['trail', `${p.trail} ${fs.existsSync(p.trail) ? '(present)' : '(missing)'}`],
    ['bash', has('bash') ? 'ok' : 'MISSING'],
    ['jq', has('jq') ? 'ok' : 'MISSING — hooks fail open (do nothing) until jq is installed'],
    ['hooks.json events', events.join(', ') || 'none'],
    ['kronicle-lite', `${k.configured}${k.via ? ` via ${k.via}` : ''}`],
    ['kronicle-lite cli', findCli('kronicle-lite') || 'not found (session_doc needs it)'],
    ['sea-lite', `${sea.configured}${sea.via ? ` via ${sea.via}` : ''}`],
    ['sea-lite cli', findCli('sea-lite') || 'not found (scope_guard needs it)'],
    ['cursor', cur ? `${cur.cursor} (${cur.source})` : 'none'],
    ['config', Object.entries(cfg).filter(([, v]) => v.via !== 'default').map(([k2, v]) => `${k2}=${v.value}`).join(' ') || 'all defaults (lifecycle pack off)'],
    ['live claims', `${liveClaims(p).length} (${pendingReleases(p).length} pending release)`],
  ];
  if (flags.probe) {
    const pr = probeMcpList();
    rows.push(['claude mcp list', pr.ok ? (pr.kronicle ? 'kronicle present' : 'no kronicle server') : `probe failed: ${pr.raw.slice(0, 120)}`]);
  }
  const s = status(p);
  rows.push(['since compact', String(s.since_compact)], ['drift', s.drift_minutes === null ? 'never refreshed' : `${s.drift_minutes}m`]);
  if (flags.json) return console.log(JSON.stringify(Object.fromEntries(rows), null, 2));
  for (const [k2, v] of rows) console.log(`${k2.padEnd(20)} ${v}`);
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (['root', 'scope', 'server'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

export function main(argv = process.argv.slice(2)) {
  const { flags, pos } = parseArgs(argv);
  const p = resolvePaths(flags.root);
  const [cmd, ...rest] = pos;
  switch (cmd) {
    case undefined:
    case 'show': return cmdShow(p, flags);
    case 'init': { ensureCard(p); console.log(`card ready at ${p.card}`); return; }
    case 'set': return cmdSet(p, rest[0], rest.slice(1).join(' '));
    case 'add-invariant': return cmdAddInvariant(p, rest.join(' '));
    case 'rm-invariant': return cmdRmInvariant(p, rest.join(' '));
    case 'refresh': return cmdRefresh(p);
    case 'render': { render(p); console.log(`rendered ${p.card}`); return; }
    case 'paths': return console.log(flags.json ? JSON.stringify(p, null, 2) : Object.entries(p).map(([k, v]) => `${k.padEnd(10)} ${v}`).join('\n'));
    case 'doctor': return cmdDoctor(p, flags);
    case 'config': return cmdConfig(p, rest, flags);
    case 'claims': return cmdClaims(p, flags);
    case 'hooks': {
      const [sub, pack] = rest;
      if (sub === 'install') { const r = hooksInstall(p, pack, { scope: flags.scope || 'user', server: flags.server }); console.log(`${pack} pack installed in ${r.settings} (${r.events.join(', ')}). Restart Claude Code to load it.`); return; }
      if (sub === 'uninstall') { const r = hooksUninstall(p, pack, { scope: flags.scope || 'user' }); console.log(`${pack}: removed ${r.removed} hook group(s) from ${r.settings}`); return; }
      throw new Error('usage: hooks install|uninstall orient-mcp --server NAME | worktree  [--scope user|project]');
    }
    case 'cursor-port': case 'cursor': {
      if (cmd === 'cursor' && !['install', 'uninstall'].includes(rest[0])) return cmdCursor(p, flags);
      const [sub] = rest;
      if (sub === 'install') { const r = cursorInstall(p, { scope: flags.scope || 'project' }); console.log(`Cursor hooks installed: ${r.hooksFile}\n  scripts: ${r.dest}\n  events: ${r.events.join(', ')}\nReload the Cursor window (or reopen the project) to pick them up.`); return; }
      const r = cursorUninstall(p, { scope: flags.scope || 'project' }); console.log(`Cursor hooks removed from ${r.hooksFile}`); return;
    }
    case 'statusline': {
      const sub = rest[0] || 'snippet';
      if (sub === 'snippet') return console.log(JSON.stringify(statuslineSnippet(), null, 2));
      if (sub === 'install') {
        try {
          const r = statuslineInstall(p, { force: !!flags.force, append: !!flags.append, scope: flags.scope || 'user' });
          console.log(`statusLine installed in ${r.settings}\n  command: ${r.command}${r.appended ? '\n  (previous status line kept on row 1)' : r.replaced ? '\n  (previous status line saved to ~/.claude/cc-anchor/statusline-previous.json)' : ''}\nRestart Claude Code or wait for the settings reload to see: ⚓ <goal> · N since compact · drift: Mm`);
          return;
        } catch (e) {
          if (e.code === 'EXISTS') { console.error(e.message); process.exitCode = 3; return; }
          throw e;
        }
      }
      if (sub === 'uninstall') { const r = statuslineUninstall(p, { scope: flags.scope || 'user' }); console.log(`statusLine ${r.restored ? 'restored to previous value' : 'removed'} in ${r.settings}`); return; }
      throw new Error('usage: statusline snippet|install [--force|--append] [--scope user|project]|uninstall');
    }
    case 'help': case '--help': case '-h':
      return console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 27).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
    default:
      throw new Error(`unknown command: ${cmd} (try: show, set goal, set project, add-invariant, rm-invariant, refresh, cursor, config, claims, hooks install, cursor install, statusline install, doctor)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`cc-anchor: ${e.message}`); process.exitCode = process.exitCode || 1; }
}
