# Changelog

All notable changes to cc-anchor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer.

## [0.4.0] — 2026-11-01

### Fixed
- **macOS: the retraction push re-read kronicle-lite on every tool call in
  the second after a store write.** The mtime gate compares the store with
  the session's stamp using bash's `-ot`/`-nt`; macOS `/bin/bash` 3.2
  compares whole seconds, so a store written in the same second as our last
  read (for instance our own `orient`'s flight-recorder write) tied, and
  every tie re-read the store — one node + sqlite spawn per tool call until
  the clock moved on (macOS CI: "no orient call on an unchanged store").
  It never looped forever (the read-only pulse doesn't write), but bursts
  were real. A tie is now settled by one `find -newer` at the filesystem's
  own precision (ns on APFS / ext4); only an exact tie there (1-s
  filesystem, one kernel tick) stays ambiguous: the pulse before a
  world-changing command always re-reads, the push re-reads once the clock
  has left the stamp's second. Reproduced on Linux with a forced 1-second
  view (`CC_ANCHOR_TEST_MTIME_SECONDS=1`, test-only); the hot-path test now
  runs in both views, plus an exact-tie test.
- **Pulse matcher (stress F05: 6/74 still missed on 0.4.0).** Backslash-
  newline continuations between tool and verb (`terraform -chdir=infra \⏎
  apply`, `kubectl -n prod \⏎ apply`, `git \⏎ push`) are joined; the verb
  counts even when quoted (`"git" "push"`; later quoted arguments still
  never match); `git subtree push` / `git lfs push` read as `git push`;
  here-documents are cut out before lexing and, when an interpreter reads
  them (`python3 - <<'PY'`, `cat <<EOF | bash`), scanned as code with
  `subprocess.run(['git','push'])`-style lists flattened (same deny-once as
  one-liners). A here-doc written to a file is not run and stays quiet.
  Corpus: 74/74 detected, 0/11 false alarms (in-repo copy, 85 cases).


The one strong live-agent result from agent-memory-bench Track B, shipped:
T1 (the runbook changes mid-session) went 0/36 for every pull setup and
10/10 with a retraction push prototype. Needs kronicle-lite ≥ 0.5.0; inert
without it.

### Added
- **Retraction push** (`PostToolUse`, switch `push`, auto = on when
  kronicle-lite is configured). Each session keeps its own kronicle-lite
  cursor (`.claude/cc-anchor/push/<sid8>.cursor`, started at the head on
  `SessionStart`, kept across compaction and resume). After a tool call
  that saw the store change, `kronicle-lite orient --cursor <c> --focus
  retractions --json` runs, the cursor is advanced and persisted, and the
  new retractions are injected as `additionalContext`: what the agent relied
  on, what it says now, the word diff (≤ 6 lines). Retractions kronicle-lite
  marks cosmetic (`cosmetic: true` / `change_class: "cosmetic"`) are counted,
  hidden unless `push_cosmetic`, and never block; without the flag
  everything counts as semantic.
- **Pulse before world-changing commands** (`PreToolUse` on `Bash`, switch
  `pulse`, auto with the push). Commands matching `pulse_match` (default
  `deploy|migrate|publish|release|git push|terraform apply|kubectl apply`;
  word boundaries added; quoted text and read-only heads ignored) are denied
  with the diff in the reason while a semantic safety/behavioral retraction
  is unreconciled: one that landed after the last tool call, or one the push
  delivered on the previous tool result with no tool call since. The
  re-run is allowed. `pulse_mode: warn` turns the deny into context.
- **Chained commands** (Track B F2: the push only fires between tool calls,
  so `build && migrate && deploy` deployed stale when the change landed
  during the build): with `pulse_chain: split` (default) a call that runs a
  world-changing step after another non-inert step is denied once with
  "run it as its own Bash call"; `cd`/`export`/`echo`/read-only steps do not
  count. `pulse_chain: check` allows chains.
- The kronicle-lite / sea-lite CLI is also found in the npx cache
  (`~/.npm/_npx/*/node_modules/<name>/dist/cli.js`): the isokron-plugins
  marketplace launches its servers with `npx -y <name>@<pin> serve`, so a
  plugin-only install has the CLI nowhere else.
- Config `push_timeout` (3 s per CLI call), `kronicle_data_dir` (else the
  kronicle MCP server's `--data-dir` / `KRONICLE_LITE_DATA_DIR` from
  `.mcp.json` or `~/.claude.json`, else the CLI default).
- **Contract tests against the real kronicle-lite CLI**
  (`tests/kronicle-contract.test.mjs`; `$KRONICLE_LITE_CLI`,
  `node_modules/kronicle-lite` or `../kronicle-lite`; fail, not skip, unless
  `CC_ANCHOR_SKIP_KRONICLE_CONTRACT=1`), passing on 0.5.0 and 0.6.0; unit
  tests for the command lexer, the renderer and every fail-open path
  (`tests/push.test.mjs`). CI installs `kronicle-lite@0.6.0`.
- A contract test that the lease heartbeat is on by default once the
  session holds sea-lite claims, with no switch set (Track A S13: without
  it a lease lapsed mid-task 3/3; with it 3/3 survived).

### Changed
- Hot path: while `kronicle-lite.db` and its `-wal` are older than the
  session's stamp the push costs two builtin `-ot` tests (no process); a
  change costs one read-only `orient --focus pulse` and, if the head moved,
  one `orient --focus retractions`. Every call is bounded (`push_timeout`)
  with the existing portable watchdog; any failure fails open, logs one
  line and backs off for 60 s.
- **A corrupt store is reported, not silently skipped** (stress finding
  S2). When an orient result says `integrity.ok === false`, the push
  injects one top-priority warning per distinct problem ("kronicle-lite
  STORE INTEGRITY FAILURE at seq N: <problem>; do not act on recalled
  runbooks…"), delivers no retractions from that store (the cursor stays
  put; they arrive after a repair), and the pulse denies world-changing
  commands until a fresh read says ok (`pulse_mode: warn` still only
  warns). kronicle-lite ≤ 0.6.0 throws on a corrupt event instead; that
  lands in the "unavailable" path below.
- **Pulse matcher hardened** (stress corpus: 11/37 world-changing forms
  were missed). Each pipeline stage is tokenized with shell-ish quoting
  (quotes stripped from the command name, whitespace and tabs collapsed),
  wrappers are dropped with their options (`sudo -E`, `env -i A=b`,
  `nice -n`, `timeout 600`), and the tool's global options are skipped
  before matching: git `-C x`, `-c k=v`, `--no-pager`, `-P`,
  `--git-dir=`, `--work-tree=`; kubectl `-n/--namespace x`, `--context x`,
  `--kubeconfig x`, `-A`; terraform `-chdir=`; npm `--prefix x`, `-w x`;
  helm, make. Read-only verbs behind global options stay quiet
  (`git --no-pager log --grep=release`). The code of interpreter one-liners
  (`python -c`, `node -e/-p`, `perl/ruby -e`, `bash/sh/zsh -c`, `eval`) is
  scanned, and a world-changing one is **denied once** (fail closed; the
  identical retry runs). Corpus: 37/37 detected, 0/8 false alarms; ported
  into `tests/push.test.mjs`. Defence in depth only: the exec-time
  boundary is a shim on PATH (next cycle).
- **"Feed offline" advisory.** A kronicle-lite that cannot be read (CLI
  missing from the cache, crash, timeout, non-JSON output) still fails
  open and is logged; after `push_offline_after` (20) consecutive calls in
  that state the agent gets one advisory that retractions are not being
  pushed and it must re-read sources itself. Resets when the store is
  readable again; `0` disables it.
- `SessionStart`, `PostToolUse` and the new Bash `PreToolUse` entries keep
  a 10 s hook timeout (two bounded CLI calls fit).
- `npm test` runs test files one at a time (`--test-concurrency=1`): the
  contract tests spawn real CLIs and made the hot-path timing budgets flaky
  on 2-core runners.

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
- **Hooks ran a different `node` than the user's.** `lib.sh` prepended
  `/opt/homebrew/bin:/usr/local/bin` to `PATH`, so a Homebrew or system node
  shadowed nvm / volta / setup-node; sea-lite's `better-sqlite3`, built for
  the user's node, then failed to load (`NODE_MODULE_VERSION` mismatch) and
  the scope guard, heartbeat and task mirror silently failed open. Those
  dirs are now appended as a fallback only.
- **`scope_timeout` was not enforced on macOS.** The guard bounded
  `scope-check` with `timeout(1)`, which macOS does not ship, so a hung
  sea-lite stalled every edit until Claude Code's hook timeout. It now uses
  `timeout`, `gtimeout`, or a portable process-group watchdog.
- **`CC_ANCHOR_SEA_MODULE` is authoritative.** A path that does not resolve
  is reported as not found instead of falling through to another sea-lite
  install in the plugin cache or `node_modules`.
- **Worktree paths keep the project's spelling.** `WorktreeCreate` printed
  git's symlink-resolved toplevel (macOS `/var` → `/private/var`); it now
  keeps `$CLAUDE_PROJECT_DIR`'s spelling when that is the toplevel.

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
