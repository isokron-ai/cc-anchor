---
name: anchor
description: Manage the cc-anchor card (goal, invariants, breadcrumbs, cursor) that is re-injected verbatim after every context compaction, and apply the post-compaction reconciliation discipline. Use when the user runs /cc-anchor:anchor or /anchor, says "update the anchor", "set the goal", "add an invariant", "install the statusline", when the goal of the session changes, or right after a compaction when the ANCHOR block appears at the top of context.
argument-hint: "[show | set goal <text> | set project <text> | add-invariant <text> | rm-invariant <n|text> | refresh | cursor | claims | config [set K V] | hooks install orient-mcp|worktree | cursor install | statusline install [--append|--force] | doctor]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs *)
---

# cc-anchor — the anchor card

The anchor card is a ≤ 25-line markdown file (`.claude/anchor.md` in the
project, or `~/.claude/cc-anchor/<hash>/anchor.md` outside a project) that
the plugin's hooks write to disk before every compaction and inject verbatim
at the top of the fresh context afterwards. Its hand-edited top holds the
project one-liner, the current goal and the invariants ("never do X"); the
generated bottom holds the last 5 tool-call breadcrumbs, the kronicle-lite
cursor when one exists, and the compacted/refreshed timestamps.

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs <command>` (no npm
dependencies). The hooks only need `bash` + `jq`.

## Current card

```
!`node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs show`
```

## Dispatch `/cc-anchor:anchor $ARGUMENTS`

Run exactly one of these, then relay the output in one or two lines:

| Arguments | Command |
| :- | :- |
| (none) or `show` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs show` (already printed above — just summarise it) |
| `set goal <text>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs set goal "<text>"` |
| `set project <text>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs set project "<text>"` |
| `add-invariant <text>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs add-invariant "<text>"` |
| `rm-invariant <n or text>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs rm-invariant "<n or text>"` |
| `refresh` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs refresh` |
| `cursor` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs cursor` |
| `statusline install` | see **Statusline install** below |
| `doctor` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs doctor` |
| `claims` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs claims` — live sea-lite claims + pending releases |
| `config` / `config set <key> <value>` / `config unset <key>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs config …` (keys: claim_guard, session_doc, subagent_release, task_mirror, task_mirror_gate, scope_guard, scope_ttl, scope_timeout; add `--scope user` for `~/.claude/cc-anchor/config.json`) |
| `hooks install orient-mcp --server <name>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs hooks install orient-mcp --server "<name>"` — ask which MCP server name kronicle-lite is registered under if unsure (`claude mcp list`; plugin-bundled = `plugin:kronicle-lite:kronicle-lite`) |
| `hooks install worktree` / `hooks uninstall <pack>` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs hooks install worktree` — tell the user this REPLACES Claude Code's git worktree creation with our script (same layout) and needs a restart |
| `cursor install` / `cursor uninstall` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs cursor install` (writes `.cursor/hooks.json` in the project; `--scope user` for `~/.cursor/`) |

Quote only the text argument (one shell string); leave the script path
unquoted and do not chain other commands with `&&`/`||`, or the pre-approved
`allowed-tools` rule will not match. Keep goals to one line; the card must
stay ≤ 25 lines or the trail is trimmed to fit.

### Statusline install (ask before overwrite)

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs statusline install` (add `--scope project` if the user said project).
2. Exit 0: done — tell the user the status line reads `⚓ <goal> · N since compact · drift: Mm` and turns yellow/red past 45/90 minutes of drift.
3. Exit 3 means a different statusLine is already configured and the command printed it. Do NOT retry blindly. Ask the user (AskUserQuestion) whether to **append** (keep theirs on row 1, anchor on row 2), **replace** it, or **cancel**. Then re-run with `--append` or `--force` accordingly.

## Lifecycle pack (0.2.0) — how to behave

Everything below only matters when the user has kronicle-lite and/or
sea-lite; the switches default to off (`config` shows them).

- **Stop hook says "release or hand off your sea-lite claim first"**: it
  lists the exact `sea_release {ticket_id, claim_token, note}` calls. Either
  finish the ticket (`sea_transition` to a terminal state) or release it with
  a hand-off note, then stop. It fires once per claim set — do not argue with
  it, do not loop.
- **"Pending sea-lite releases" in a SessionStart / `anchor` block**: a
  subagent (or a removed worktree) left claims behind. Release them with the
  listed calls before taking new work; they disappear once released.
- **Subagents**: if you are the subagent and the SubagentStop hook blocks
  you, release your claims with the listed calls and finish again.
- **Scope guard denied an edit**: someone else — another actor, or another
  Claude Code session (`claude#4f7a1e03` is a different session from yours
  even with the same name) — holds a live claim whose scope covers that
  path. Do not work around it: the guard does not see Bash, so `sed -i`,
  heredocs or redirects to the file would bypass it and the pre-commit
  guard will refuse the commit anyway. Take other work (`sea_next`), wait
  for the expiry shown, or coordinate with the holder.
- **TaskCompleted refused with "open predecessor(s)"**: the mirrored sea-lite
  ticket depends on unfinished work. Finish or unlink those first.
- **Session documents**: with `session_doc` on, every Stop writes
  `session-<date>-<id>` to kronicle-lite; mention the slug when handing off.
- Turning things on for the user: `config set claim_guard true`,
  `config set session_doc true`, `config set scope_guard true`,
  `config set task_mirror true`. Explain in one line what each does (see the
  README table) and that `CC_ANCHOR_<KEY>=0` in the shell overrides.

## When to refresh the card

Refresh (`set goal` / `add-invariant` / `refresh`) at these moments, without
being asked:

- the user states or changes the task ("now let's…", "switch to…", "actually…");
- you finish a milestone and start the next one;
- the user gives a standing rule ("never touch X", "always run Y first") → `add-invariant`;
- the statusline or a Stop-hook nudge reports drift ≥ 45 min and the goal line is stale;
- immediately before a long tool-heavy stretch (big refactor, test loop) — compaction is likely during it.

Do not refresh for every message; the card is an anchor, not a log. The
breadcrumbs update themselves on every tool call.

## After a compaction: how to read the card

The SessionStart hook injects it under the header **`ANCHOR — verbatim, read
before anything else`**. Read it in this order:

1. **Invariants** — binding, verbatim. They outrank anything in the
   compaction summary.
2. **Goal** — what you are doing. If the summary describes a different goal,
   the card wins unless the user says otherwise in a live message.
3. **Trail** — the last tool calls before compaction. Use them to re-open the
   files you were in the middle of instead of guessing from the summary.
4. **Cursor** (only with kronicle-lite) — call `get_system_state` with
   `since_cursor=<cursor>` before material work; reconcile its retractions;
   carry the returned cursor forward.

## Demote state-claims, mark stale as RETRACTED

This is the discipline from the IsoKron wake contract, adapted for sessions
without a chain:

- **Source ranking** when two things disagree: (1) a fresh tool result or the
  file on disk, (2) a live user message, (3) the anchor card, (4) session
  reasoning that was grounded at the time, (5) the compaction summary. Never
  act on (5) alone.
- **Demote**: every factual claim that comes only from the summary carries the
  tag *"as-of before compaction — verify before acting"*. Verify by reading
  the file, running the command, or asking.
- **Retract, don't archive**: when a claim turns out to be wrong, say once
  "RETRACTED: ⟨claim⟩ — now ⟨truth⟩ (source)" and stop using it as a premise.
  Do not keep it around as "historical context"; stale premises are how
  post-compaction sessions corrupt their own work.
- **Preserve the card verbatim** at the top of any summary you write
  yourself (hand-offs, PR descriptions of in-progress work, notes for the next
  session). Quote it; do not paraphrase it.
- **Manual re-ground**: the bare word `anchor` typed by the user re-injects
  the card mid-session. Treat it as a signal that the user noticed drift you
  did not.

## Files

- Card: `.claude/anchor.md` (commit it or not — your call; it is small).
- Runtime: `.claude/cc-anchor/{trail.jsonl,state.json,cursor,claims.json,pending-release.jsonl,scope-cache.json,tasks.json,log}` — add
  `.claude/cc-anchor/` to `.gitignore`.
- Config: `.claude/cc-anchor.json` (project) / `~/.claude/cc-anchor/config.json` (user).
- Cursor sources, in order: `.claude/cc-anchor/cursor` (captured from a
  `get_system_state` result), `.cc-anchor-cursor`, `.sextant-cursor`,
  `.kronicle-cursor`.
