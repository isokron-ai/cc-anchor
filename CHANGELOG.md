# Changelog

All notable changes to cc-anchor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer.

## [0.3.0] — 2026-11-01

Fixes from the adoption audit (B1, B2, B5 on the cc-anchor side). Needs
sea-lite ≥ 0.4.0 for the scope guard and the heartbeat; with an older
sea-lite both fail open and say so in the log.

### Fixed
- **The scope guard never denied anything (B2).** It passed an absolute
  path the CLI rejected, read text output as JSON, expected field names the
  CLI never emitted (`ticket/paths/expires`) and passed no identity — so
  every real conflict failed open — and its tests used a fake sea-lite that
  spoke the same wrong contract. It now speaks sea-lite 0.4.0's documented
  contract: `scope-check --json --session <session_id> <absolute file>`,
  `schema: "sea-lite.scope-check/1"`, `holder_label` / `ticket_id` /
  `title` / `held` / `claim_expires_at`; `outside_repo` (exit 2) is allowed
  quietly; a sea-lite without the JSON contract fails open with an explicit
  "older than 0.4.0" log line. The deny reason names holder, ticket,
  title, locked paths and expiry.
- **Two sessions of one actor are told apart (B1).** The guard passes the
  hook's `session_id`; sea-lite maps it to the identity the session's MCP
  server claims under, so another Claude Code session running the same
  `--actor` is denied and the session's own claims never are. Verdicts are
  cached per **session and path** (one session's "ok" used to answer for
  every session in the project).
- **The `Stop` claim guard leaked other sessions' claims.** `claims.json`
  is shared by every session of a project; the guard now considers only the
  stopping session's claims, instead of blocking an unrelated session and
  printing another session's claim tokens.

### Added
- **Lease heartbeat (B5)** (`heartbeat`, auto): PostToolUse renews the
  session's sea-lite claims in the background, at most once per
  `heartbeat_interval` s (60) per session, so a task longer than one lease
  keeps its lock. Builtins only when not due.
- Config `sea_session` (Cursor: name the session your sea-lite server runs
  with) and `sea_actor`; `CC_ANCHOR_SEA_DATA_DIR` is passed to the guard and
  the heartbeat as `--data-dir`.
- **Contract tests against the real sea-lite CLI** (`tests/sea-contract.test.mjs`):
  same-actor/other-session deny, holder allowed, absolute path + `--json` +
  `--session` on the command line, outside-repo and other-repo allowed,
  per-session cache, Cursor adapter, heartbeat. They find the CLI at
  `$SEA_LITE_CLI`, `node_modules/sea-lite`, or a sibling `../sea-lite`
  checkout and fail (not skip) when it is missing, unless
  `CC_ANCHOR_SKIP_SEA_CONTRACT=1`. CI installs `sea-lite@^0.4.0`.

### Changed
- Docs: the scope guard does not see Bash-tool edits (`sed -i`,
  redirects, formatters); sea-lite's git pre-commit guard is the backstop.

## [0.2.0] — 2026-11-01

### Added — lifecycle hooks pack (all opt-in; inert without kronicle-lite / sea-lite)
- **Claim tracking**: `PostToolUse` folds every `mcp__*__sea_{claim,next,
  create,release,transition,refresh}` result into `.claude/cc-anchor/claims.json`
  (`scripts/claims.jq`), keyed by ticket, tagged with `agent_id`, `session_id`,
  `cwd` and lease expiry; terminal transitions and releases (prefix ids)
  drop entries, expired leases never count as live. Bash-regex gated: no cost
  for other tools (PostToolUse still ~16 ms).
- **`Stop` claim guard** (`claim_guard`): blocks the stop once per claim set
  with the exact `sea_release {ticket_id, claim_token, note}` calls; honours
  `stop_hook_active`; a claim block wins over the drift nudge.
- **`Stop` session document** (`session_doc`): `kronicle-lite put
  session-<date>-<sid8>` with the verbatim card + `last_assistant_message`,
  skipped when unchanged, run in the background after the decision is
  printed (`CC_ANCHOR_SYNC=1` inline).
- **`SubagentStop`** (`subagent_release`, auto when sea-lite is configured):
  block once with the release calls for the stopping `agent_id`'s claims and
  append them to `pending-release.jsonl`; `SessionStart` and the `anchor`
  re-ground print live pending releases, pruned once released / expired.
- **`PreToolUse` scope guard** (`scope_guard`, matcher
  `Edit|Write|MultiEdit|NotebookEdit`): `sea-lite scope-check --paths <file>`
  (exit 1 + `{conflicts:[{holder,ticket,paths,expires}]}`) →
  `hookSpecificOutput.permissionDecision: "deny"` naming the holder. Per-path
  verdict cache (`scope_ttl`, invalidated by any `sea_*` result), ~6 ms off,
  ~20 ms cached; missing binary / unsupported subcommand / timeout fail open
  and log once. Windows backslash paths normalised.
- **Task mirror** (`task_mirror`): `TaskCreated` → sea-lite ticket via the
  library (`scripts/task-mirror.mjs`; `idempotency_key: cc-task:<id>`, tags
  `cc-task`, `cc-task:<id>`); `TaskCompleted` → claim + `sea_transition
  resolved`; `task_mirror_gate` (default on) refuses completion with exit 2
  while a predecessor (`depends_on` / `blocks`) is open. Mirror failures never
  block. Verified against sea-lite 0.1.1.
- **`InstructionsLoaded`** stamp: `Instructions:` line on the card
  (`instructions_files`, `instructions_loaded_at`, `instructions_reason` in
  `state.json`); on `load_reason: compact` arms a one-shot re-assert of the
  card via `UserPromptSubmit` when `SessionStart(compact)` did not run for
  that compaction (`compact_injected_count` vs `compact_count`).
- **`SessionStart(resume|fork)`** relays `seconds_since_last_response` /
  `prompt_cache_likely_expired` as a drift line.
- **Worktree pack** (`anchor.mjs hooks install worktree`, settings.json, not
  `hooks.json` because a `WorktreeCreate` hook replaces git behaviour for
  everyone): `worktree-create.sh` reproduces the default layout +
  `.worktreeinclude`, stamps the trail, copies the card into the worktree;
  `worktree-remove.sh` queues releases for claims taken inside it, removes
  directory and branch.
- **Optional `mcp_tool` orient hook** (`anchor.mjs hooks install orient-mcp
  --server NAME`): `SessionStart` matcher `compact|clear` calling
  `get_system_state` cold — the reference's `input` templating cannot carry a
  cursor from disk and launch-time SessionStart skips `mcp_tool` hooks, so
  the shell path stays primary.
- **Cursor port**: `cursor/hooks.json` + `cursor/adapter.sh` translating
  `sessionStart`, `preCompact`, `postToolUse`, `preToolUse`, `stop`,
  `subagentStop` to and from the Claude Code shapes; `anchor.mjs cursor
  install|uninstall [--scope project|user]`.
- CLI: `config [show|set|unset]`, `claims`, `hooks install|uninstall`,
  `cursor install|uninstall`; `doctor` reports sea-lite, both CLIs, the
  effective config and live claims.
- `lib.sh`: config layer (`cc_cfg_raw`/`cc_on`, bash pattern matching, no jq
  on the hot path), `cc_sea_configured`, `cc_find_cli`/`cc_run_cli`
  (env → PATH → plugin cache), `cc_log`/`cc_log_once`, claim and pending
  helpers, `cc_emit_block`/`cc_emit_deny`.
- Tests: 71 (from 42) against payloads copied from the hooks reference and
  Cursor's hooks page, plus a file-backed sea-lite double and a real-package
  run; `demo/headless-proof-lifecycle.sh`.

### Changed
- `hooks.json` registers `InstructionsLoaded`, `PreToolUse`, `SubagentStop`,
  `TaskCreated`, `TaskCompleted` (all command hooks; no `mcp_tool` hook ships
  in the plugin). `Stop`/`PreToolUse`/task hooks have a 10 s timeout.
- `InstructionsLoaded` matcher is
  `session_start|compact|nested_traversal|path_glob_match|include`: measured
  on Claude Code 2.1.316, a plugin hook never receives `session_start`
  (plugins register after the eager load), lazy loads and `compact` do.
- Field reads from `jq` use the unit separator as `IFS` instead of a tab: an
  empty leading field (no `cwd`) no longer shifts later values.
- `statusline install` and the packs copy `claims.jq` next to `lib.sh`.

### Fixed
- `render.jq` reserves a line for the `Instructions:` row so the card stays
  ≤ 25 lines.

[0.2.0]: https://github.com/rafe-walker/cc-anchor/compare/v0.1.0...v0.2.0

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
