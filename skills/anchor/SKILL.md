---
name: anchor
description: Manage the cc-anchor card (goal, invariants, breadcrumbs, cursor) that is re-injected verbatim after every context compaction, and apply the post-compaction reconciliation discipline. Use when the user runs /cc-anchor:anchor or /anchor, says "update the anchor", "set the goal", "add an invariant", "install the statusline", when the goal of the session changes, or right after a compaction when the ANCHOR block appears at the top of context.
argument-hint: "[show | set goal <text> | set project <text> | add-invariant <text> | rm-invariant <n|text> | refresh | cursor | statusline install [--append|--force] | doctor]"
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

Quote only the text argument (one shell string); leave the script path
unquoted and do not chain other commands with `&&`/`||`, or the pre-approved
`allowed-tools` rule will not match. Keep goals to one line; the card must
stay ≤ 25 lines or the trail is trimmed to fit.

### Statusline install (ask before overwrite)

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/anchor.mjs statusline install` (add `--scope project` if the user said project).
2. Exit 0: done — tell the user the status line reads `⚓ <goal> · N since compact · drift: Mm` and turns yellow/red past 45/90 minutes of drift.
3. Exit 3 means a different statusLine is already configured and the command printed it. Do NOT retry blindly. Ask the user (AskUserQuestion) whether to **append** (keep theirs on row 1, anchor on row 2), **replace** it, or **cancel**. Then re-run with `--append` or `--force` accordingly.

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
- Runtime: `.claude/cc-anchor/{trail.jsonl,state.json,cursor}` — add
  `.claude/cc-anchor/` to `.gitignore`.
- Cursor sources, in order: `.claude/cc-anchor/cursor` (captured from a
  `get_system_state` result), `.cc-anchor-cursor`, `.sextant-cursor`,
  `.kronicle-cursor`.
