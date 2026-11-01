# Roadmap

## Shipped in 0.4.0

- Retraction push after every tool call; pulse before world-changing
  commands (global options, quoting, continuations, one-liners, here-docs);
  integrity failures surfaced and blocking; feed-offline advisory; macOS
  bash 3.2 hot path.


## Next (2026-11-01)

- **Per-subagent cursors** (built on branch `next-cycle`) — each subagent gets its own retraction cursor
  (or the push fans out), so a sibling can't miss a change that another
  subagent already consumed, and the parent doesn't believe everyone is
  current when only one subagent saw it.
- **Post-Bash claimed-path check** (built on branch `next-cycle`) — after every Bash call, compare
  `git status --porcelain` paths against live sea-lite claims held by other
  sessions and warn immediately (the Edit/Write scope guard doesn't see
  `sed -i` or redirects; pre-commit is too late).
- **Exec-time pulse via kronicle-lite shims** — document and auto-wire
  `kronicle-lite shim install` once it ships, so the pulse covers changes
  landing during a long command and commands hidden in wrappers.
- **Empty card at startup** (fixed on `next-cycle`) — `InstructionsLoaded` creates a "Project:
  (unset)" card that `SessionStart` then injects; skip it when nothing is set.

## Known limits (0.4.0)

- Subagents share the session's retraction cursor (fixed on `next-cycle`).

- Cursor has no post-tool context output, so it gets no push; use the
  kronicle-lite pulse instruction (and shims, when shipped).
- A change landing during a single long command is caught at the next tool
  call.
