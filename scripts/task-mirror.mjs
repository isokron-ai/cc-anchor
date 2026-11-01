#!/usr/bin/env node
/**
 * cc-anchor — mirror Claude Code's native task list into sea-lite tickets.
 *
 *   node task-mirror.mjs created   < TaskCreated hook JSON
 *   node task-mirror.mjs completed < TaskCompleted hook JSON
 *
 * Called by scripts/task-created.sh / task-completed.sh only when the
 * `task_mirror` switch is on. Writes through the sea-lite *library*
 * (`SeaLite` from the package the sea-lite plugin pins under its
 * node_modules, or $CC_ANCHOR_SEA_MODULE), opening the same SQLite store
 * the MCP server uses — a hook cannot call MCP tools, and a `type:
 * "mcp_tool"` hook cannot express the TaskCompleted side (it needs the
 * ticket id and a claim token, neither of which is in the hook input).
 *
 * (The library applies no zod defaults — the MCP layer does — so every
 * field the handlers read is passed explicitly.)
 *
 * TaskCreated  → sea_create { title: task_subject, body: task_description,
 *                 kind: "chore", priority: "medium", status: "triaged", tags: ["cc-task",
 *                 "cc-task:<task_id>"], idempotency_key: "cc-task:<task_id>" }
 *                 Idempotent: sea-lite replays the first result for a reused
 *                 key, and the tag lets TaskCompleted find the ticket even
 *                 when tasks.json (the local task_id → ticket_id map) is gone.
 *                 Never blocks creation; a mirror failure is logged.
 * TaskCompleted → if `task_mirror_gate` is on (default) and the ticket has
 *                 an open predecessor (it depends_on a non-terminal ticket,
 *                 or a non-terminal ticket blocks it): exit 2 with the
 *                 reason on stderr — the reference says exit 2 keeps the task
 *                 open and feeds stderr back to the model. Otherwise claim +
 *                 sea_transition resolved (idempotency_key
 *                 "cc-task:<task_id>:resolved"). already_claimed by another
 *                 actor, already terminal, or no ticket → exit 0 (fail open,
 *                 logged). Never exit 2 for a mirror failure.
 *
 * Exit codes: 0 ok / fail-open; 2 block (TaskCompleted gate only).
 * Env: CC_ANCHOR_SEA_MODULE (dir or index.js), KRONICLE_LITE_DATA_DIR /
 *      CC_ANCHOR_SEA_DATA_DIR, SEA_LITE_ACTOR (default "cc-anchor"),
 *      CC_ANCHOR_RUN (runtime dir for tasks.json + log), CC_ANCHOR_TASK_MIRROR_GATE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2];
const runDir = process.env.CC_ANCHOR_RUN || '';
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function log(msg) {
  if (!runDir) return;
  try { fs.mkdirSync(runDir, { recursive: true }); fs.appendFileSync(path.join(runDir, 'log'), `${nowIso()} task_mirror: ${msg}\n`); } catch { /* ignore */ }
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

/** Locate the sea-lite package: env, plugin cache, project, global. */
export function findSeaModule(env = process.env) {
  const home = env.HOME || os.homedir();
  const cands = [];
  if (env.CC_ANCHOR_SEA_MODULE) cands.push(env.CC_ANCHOR_SEA_MODULE);
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  try {
    for (const mk of fs.readdirSync(cache)) {
      for (const plug of safeDir(path.join(cache, mk))) {
        for (const ver of safeDir(path.join(cache, mk, plug))) {
          cands.push(path.join(cache, mk, plug, ver, 'node_modules', 'sea-lite'));
        }
      }
    }
  } catch { /* no cache */ }
  cands.push(path.join(process.cwd(), 'node_modules', 'sea-lite'));
  for (const c of cands) {
    const entry = resolveEntry(c);
    if (entry) return entry;
  }
  return null;
}
function safeDir(d) { try { return fs.readdirSync(d); } catch { return []; } }
function resolveEntry(c) {
  if (!c) return null;
  if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  for (const f of ['dist/index.js', 'index.js']) {
    const p = path.join(c, f);
    if (fs.existsSync(p)) return p;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8'));
    const m = pkg.exports?.['.']?.import || pkg.exports?.['.']?.default || pkg.module || pkg.main;
    if (m && fs.existsSync(path.join(c, m))) return path.join(c, m);
  } catch { /* not a package */ }
  return null;
}

function tasksFile() { return runDir ? path.join(runDir, 'tasks.json') : null; }
function readTasks() { const f = tasksFile(); if (!f) return {}; try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function writeTasks(map) { const f = tasksFile(); if (!f) return; try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(map, null, 2) + '\n'); } catch { /* ignore */ }
}

const TERMINAL = new Set(['resolved', 'wont_fix', 'duplicate', 'dropped', 'merged']);

async function openStore() {
  const entry = findSeaModule();
  if (!entry) throw new Error('sea-lite module not found (set CC_ANCHOR_SEA_MODULE)');
  const mod = await import(pathToFileURL(entry).href);
  const SeaLite = mod.SeaLite || mod.default?.SeaLite;
  if (!SeaLite) throw new Error(`no SeaLite export in ${entry}`);
  const dataDir = process.env.CC_ANCHOR_SEA_DATA_DIR || process.env.KRONICLE_LITE_DATA_DIR;
  const actor = process.env.SEA_LITE_ACTOR || 'cc-anchor';
  return new SeaLite({ ...(dataDir ? { dataDir } : {}), actor });
}

function findTicket(store, taskId) {
  const map = readTasks();
  if (map[taskId]) {
    try { return store.get({ id: map[taskId] }); } catch { /* fall through */ }
  }
  try {
    const r = store.list({ tag: `cc-task:${taskId}`, include_terminal: true, claimed: 'any', limit: 1, view: 'compact' });
    const t = r.tickets?.[0] || r.items?.[0];
    if (t) return store.get({ id: t.id });
  } catch { /* ignore */ }
  return null;
}

async function created(input) {
  const store = await openStore();
  try {
    const key = `cc-task:${input.task_id}`;
    const r = store.create({
      title: String(input.task_subject || input.task_id).slice(0, 500),
      body: String(input.task_description || ''),
      kind: 'chore',
      priority: 'medium',
      status: 'triaged',
      tags: ['cc-task', key],
      idempotency_key: key,
      dry_run: false,
    });
    const id = r.ticket?.id;
    if (id) { const map = readTasks(); map[input.task_id] = id; writeTasks(map); }
    log(`created ${input.task_id} → ${id}${r.replayed ? ' (replayed)' : ''}`);
  } finally { store.close?.(); }
}

async function completed(input) {
  const store = await openStore();
  try {
    const got = findTicket(store, input.task_id);
    if (!got) { log(`completed ${input.task_id}: no mirrored ticket; nothing to do`); return 0; }
    const t = got.ticket;
    const gate = !/^(0|false|no|off)$/i.test(process.env.CC_ANCHOR_TASK_MIRROR_GATE || '1');
    if (gate) {
      const open = (got.links || []).filter((l) =>
        ((l.direction === 'out' && l.link_type === 'depends_on') || (l.direction === 'in' && l.link_type === 'blocks'))
        && l.peer && !TERMINAL.has(l.peer.status));
      if (open.length) {
        const names = open.map((l) => `${l.peer.id.slice(0, 8)} "${l.peer.title}" (${l.peer.status})`).join('; ');
        process.stderr.write(`sea-lite: task "${input.task_subject}" mirrors ticket ${t.id.slice(0, 8)} which still has ${open.length} open predecessor(s): ${names}. Resolve them first, or unlink them in sea-lite (sea_link remove).\n`);
        log(`completed ${input.task_id}: BLOCKED, open predecessors ${names}`);
        return 2;
      }
    }
    if (TERMINAL.has(t.status)) { log(`completed ${input.task_id}: ticket already ${t.status}`); return 0; }
    let token;
    try {
      const c = store.claim({ ticket_ids: [t.id], lease_seconds: 60 });
      token = c.claims?.[0]?.claim_token;
    } catch (e) {
      log(`completed ${input.task_id}: cannot claim ${t.id} (${e.code || e.message}); leaving ticket as is`);
      return 0;
    }
    store.transition({ ticket_id: t.id, claim_token: token, to: 'resolved', reason: `Claude Code task ${input.task_id} completed`, idempotency_key: `cc-task:${input.task_id}:resolved`, dry_run: false });
    log(`completed ${input.task_id} → ${t.id} resolved`);
    return 0;
  } finally { store.close?.(); }
}

async function main() {
  const input = readStdin();
  if (!input || !input.task_id) return 0;
  if (mode === 'created') { await created(input); return 0; }
  if (mode === 'completed') return await completed(input);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { log(`error: ${e.message}`); process.exitCode = 0; });
}
