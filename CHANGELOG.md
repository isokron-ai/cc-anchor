# Changelog

All notable changes to cc-anchor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer.

## [0.1.0] — 2026-10-31

### Added
- Anchor card (`.claude/anchor.md`, ≤ 25 lines): project one-liner, goal,
  invariants, last 5 tool-call breadcrumbs, kronicle-lite cursor,
  compacted/refreshed stamps. Home fallback at
  `~/.claude/cc-anchor/<hash>/` outside a project.
- `PreCompact` hook: writes the card verbatim and stamps `compacted_at`.
- `SessionStart` hook: re-injects the card under
  `ANCHOR — verbatim, read before anything else` after a compaction (and
  under a session-start header on startup/resume/clear/fork), followed by the
  reconciliation discipline; appends the `since_cursor` instruction only when
  a kronicle-lite server or plugin is configured.
- `PostToolUse` hook (bash + one jq call): rolling trail, card re-render,
  cursor capture from `mcp__*__get_system_state` results.
- `UserPromptSubmit` hook: bare word `anchor` re-injects the card.
- `Stop` hook: trail rotation and a rate-limited drift nudge.
- Status line `⚓ <goal> · <N> since compact · drift: <M>m` with yellow/red
  warning past 45/90 minutes; `statusline install` with ask-before-overwrite,
  `--append`, `--force`, `uninstall`.
- `/cc-anchor:anchor` skill: `show`, `set goal|project`, `add-invariant`,
  `rm-invariant`, `refresh`, `cursor`, `statusline install`, `doctor`, plus
  the post-compaction reading order and the demote/RETRACTED discipline.
- Self-hosted marketplace (`.claude-plugin/marketplace.json`), CI
  (shellcheck, node:test, `claude plugin validate --strict --profile
  directory`), 42 tests against payloads copied from the hooks reference.

[0.1.0]: https://github.com/rafe-walker/cc-anchor/releases/tag/v0.1.0
