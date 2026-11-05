# Changelog

All notable changes to cc-anchor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
SemVer.

## [Unreleased]

### Added
- **Audit telemetry (opt-in).** `scripts/telemetry.sh` + `scripts/telemetry.jq`
  on `Stop` / `SubagentStop` / `PreCompact` / `SessionEnd` (new hook) record
  provider-reported usage per API response and per turn, tool result sizes
  and latency, and compactions from the transcript, incrementally, as JSONL
  (`cca.telemetry/1`). Tool-response tokens are a separate bytes/4 estimate,
  never added to the provider's counts. No content is logged; tool names are
  redacted. `--scan <transcript>` gives the same records offline; `--kronicle`
  maps them to draft kronicle-lite audit events (`call_measured`, `turn_usage`).
- **Observer-effect switch** `CC_ANCHOR_OBSERVER=off|telemetry|telemetry+anchors`:
  `off` and `telemetry` make every other cc-anchor hook a no-op;
  `off` also wins over `CC_ANCHOR_TELEMETRY=1`.
- Telemetry is bounded and exactly-once: reads at most a 4 MiB window per jq
  pass and 5 s per run (resumed next run), and moves the offset atomically
  after the records are written. A seen-set of message ids, tool_use ids and
  compactions stops a response straddling two windows, or a truncated or
  rewritten transcript, from being counted twice. No transcript copies; one
  run at a time (a live lock is never broken). Invalid usage counts are
  flagged (`invalid_usage`), never coerced to 0. The overhead record is
  written only on runs that flushed.

### Fixed
- **Pending gate shared across subagents (L2-05, hardening-live).** One
  agent's re-read cleared the gate for every agent of the session (they
  share the MCP server's kronicle-lite actor), and a subagent started after
  the coordinator had consumed the push got neither the push nor a deny.
  Each agent now has its own reconciliation ledger (`scripts/owed.jq`;
  `<sid8>[.a-<agent>].owed/.done/.reads` under `push/`): it is denied until
  its own tool result shows the current version. A newer change of the same
  block replaces the owed item; a subagent first seen alive inherits what
  the session still owes; SubagentStop parks the ledger and a resume with
  the same `agent_id` takes it back. Inert on kronicle-lite ≤ 0.7.0.
- `cc_kl_pending_fmt` moved into `scripts/owed.jq` (mode `fmt`) so the gate
  and the ledger print the same pending lines.

- **Ledger gate bypasses (PR #6 review).**
  - A doc read with no current version, a partial read (`| head`), an
    erroring get, a grep that mentions the doc, or an `echo` of the new text
    no longer clears an owed change. Evidence must be a kronicle-lite tool
    result, or one plain successful `kronicle-lite get`, and kronicle-lite
    must confirm the read (`pending --actor`). Content hashes are compared
    when both sides carry one.
  - The run dir is guarded in the Write/Edit hook and the Bash pulse.
  - `.owed.sum` makes a truncated or edited ledger fail closed.
  - The ledger lock is never broken while its owner lives. A busy lock skips
    the update and fails closed (a queued feed, `<agent>.busy`) instead of
    writing unlocked.
  - No jq while kronicle-lite is in use: the pulse denies, loudly.

## [0.5.1] — 2026-11-01

Fixes the pending gate after hardening round 2 (agent-memory-bench
`hardening-hooks` @ 3b10850 and 386db8c, `stress/findings/hooks.md`) and the
live-agent round (`hardening-live` @ 738edc5, L2-02 … L2-04).
The gate no longer tries to find dangerous commands in shell text.

### Changed
- **Gate semantics (H2-02, H2-04, H2-05, H2-07, H2-09).** Nothing pending
  (and the store reads ok): every Bash call runs — no `pulse_match` regex,
  no chain-split or one-liner denials (19/25 false alarms in round 2, and
  `pulse_chain: split` re-denied every retry with nothing pending).
  Something pending (`pending_count > 0` for any of the agent's actors on
  kronicle-lite ≥ 0.8.0, an unseen blocking retraction on ≤ 0.7.0, or an
  integrity failure): every Bash call is denied unless the new
  `scripts/readonly.jq` proves it read-only (cat, less, head, tail, ls,
  grep, rg, find without -exec/-delete, wc, diff, jq, git status/log/diff/
  show/branch --list/rev-parse/ls-files…, kronicle-lite get/pending/orient,
  sea-lite board/list/show…, echo/printf, pwd, which, cd). Anything it does
  not fully understand — assignments, subshells, `$( )`, `<( )`, `$'…'`,
  here-docs and here-strings, `source`, interpreters, redirections other
  than to /dev/null, `&`, unbalanced quotes, calls over `pulse_max_bytes`
  (8192) — is not read-only. The deny names each change (document ›
  heading, the version read → the current one, the diff), what still runs
  and why this call does not, and that re-reading clears it.
  `scripts/pulse.jq` is gone; `pulse_match` and `pulse_chain` are ignored.
- **Fail closed while pending (H2-02, H2-09).** A classifier error counts as
  not read-only, and a kronicle-lite read that fails or times out falls
  back to the last answer: a change known to be pending still denies;
  nothing known pending still fails open. The classifier is one regex scan
  (a 200 KB command took 14 s in jq before, past the 10 s hook timeout; now
  over-size is refused up front). PreToolUse Bash hook timeout 10 → 15 s.
- Pending items now say which version the agent read (`you read it at seq
  N`).

### Fixed
- **H2-01 (S1)**: `--actor=X` in the kronicle-lite server's args was not
  parsed, so the gate checked `local-agent` (0 pending), allowed `git push`
  and told the agent the change it relied on did not block. `--actor X`,
  `--actor=X` and `KRONICLE_LITE_ACTOR` are all read; the "nothing blocks"
  context now only appears when nothing is pending for any of the agent's
  actors and names them.
- **H2-03**: `--data-dir=DIR` is parsed; the kronicle-lite server is found by
  its command line (`npx kronicle-lite`, `node …/kronicle-lite/dist/cli.js`,
  `kronicle-lite serve`, command strings with spaces) whatever its key, so
  `"memory": {command: "kronicle-lite", …}` gets the right actor and store;
  the gate is on the **union** of the configured actor and every `actor_id`
  the agent passed to any MCP tool (any server key or plugin prefix) — an
  `actor_id` on a non-read tool no longer switches the gated actor, and
  naming another actor never clears a pending change. Per agent: a
  subagent with its own actor is gated on it and on the server actor; the
  parent is not gated on a subagent's private actor.
- **H2-10 (S1)**: a subagent's learned actors survived nothing: `SubagentStop`
  deleted them with its cursor, so a resumed subagent (same `agent_id`) was
  gated on the server actor and its `git push` allowed with the "none of it
  blocks" text. `SubagentStop` now drops the cursor files but keeps
  `<sid8>.a-<agent>.actors`.
- **H2-11**: during the 60 s back-off after one slow read the pulse used the
  cached pending count (0, from before the change) and allowed silently.
  The pulse no longer honours the back-off (the push still does): when the
  store may have changed it reads, bounded by `push_timeout`; when that read
  fails and the agent has had an answer before, the cached answer is stale,
  not "clear" — every call that is not read-only is denied (`pulse_mode:
  warn`: warned) with "kronicle-lite could not be read just now". A CLI
  that never answered in this session still fails open.
- **H2-12 (cc-anchor side)**: `kronicle-lite shim ack`, `shim install` /
  `uninstall` and `pending ack` (any spelling: npx, node …/cli.js, quoted,
  behind an assignment) clear or reconfigure kronicle-lite's own gate
  without a re-read. The pulse denies them in any mode, pending or not,
  even without kronicle-lite configured, and tells the agent to re-read the
  pending items or ask the operator.
- **L2-02**: a tamper that rewrites a stored block or event without moving
  the head (projection-only) never reached the agent: cc-anchor read only
  `orient --focus pulse` (no integrity verdict) unless the head moved. When
  the store changed but the head did not, it now runs the read-only
  `kronicle-lite verify-chain` (bounded by `push_timeout`; inconclusive on
  timeout), so a mismatch is seen at once: the push warns (top priority)
  and the pulse lets only read-only calls run.
- **L2-03 (cc-anchor side)**: a damaged store (kronicle-lite exit 77, SQLite
  CORRUPT / NOTADB, "database disk image is malformed") is an integrity
  failure, not an outage: warned and gated at once instead of failing open
  and advising "offline" after 20 calls. A genuinely unavailable
  kronicle-lite is told to the agent on the first unchecked non-read-only
  Bash call (and denies once there is a stale answer, H2-11).
- **L2-04**: with no actor named in any MCP config cc-anchor can read
  (`--mcp-config`, a plugin server …) the pending gate asked `local-agent`,
  got 0 and also switched off the retraction rule. The actor is now known
  to be a guess: the 0.4.0 retraction rule stays on next to the pending
  gate, and the agent is told once (with the first change, and in every
  deny) to set `CC_ANCHOR_KRONICLE_ACTOR`. `$CLAUDE_CONFIG_DIR/.claude.json`,
  `$CLAUDE_CONFIG_DIR/settings.json` and its plugin cache are read too.
- **H2-08**: `~/.claude.json` `projects[…]` is looked up by the literal
  project path and by its physical (symlink-resolved) path (also for
  sea-lite detection).

### Fixed — sea-lite claim guards
- **H2-21 / H2-23 (cc-anchor side)**: the Edit/Write scope guard's verdict
  cache is dropped when the sea-lite store changes (a new claim by anyone),
  and a timeout, crash, missing CLI, answer without the JSON contract or an
  `exit 2` other than `outside_repo` is never cached as "ok" (it fails open
  for that edit only).
- **H2-22**: when sea-lite is unavailable the claim guards still fail open,
  but now tell the agent once per outage (shared latch for the scope guard
  and the Bash guard), like the kronicle-lite "feed offline" advisory.
- **H2-20**: one slow `sea-lite board` call no longer empties the Bash
  guard's claim cache for `bash_guard_ttl`: the last good claims stay in
  use, the next refresh is tried after 5 s (at once when there are none),
  and the agent is told the guard is degraded.
- **H2-18**: a claimed path removed through its parent (`rm -rf src`,
  `mv src src-old`, `git checkout` of a branch without `src/`) is reported
  when it existed before the call (seen at PreToolUse, at the last check,
  or known to git).
- **H2-19**: writes that land after a Bash call that started background
  work (`&`, `nohup`, `setsid`, `disown`) are reported at the following
  tool calls (up to 10 minutes).
- **H2-24**: a claim on a git-ignored path is reported (only ignored output
  *inside* a claim is dropped); a subagent editing a claim its own session's
  main agent or a sibling took (known from the `sea_*` results; a CLI claim
  of the session counts as the main agent's) is warned.
- A Bash payload without `tool_use_id` is checked against a per-session
  stamp instead of skipped.

### Documentation
- README: the gate, the read-only allowlist, fail-closed rules, and what is
  out of scope (H2-06: git indirection, quoted code arguments, functions /
  aliases / exported env from before the change, Windows spellings — all
  denied while something is pending since none is read-only, but only an
  exec-time shim sees them otherwise; `git commit --no-verify`-style
  bypasses of other guards).

### Tests
- `tests/stress/gate.sh` (the round-2 harness, 29 checks verbatim + 36 for
  0.5.1: nothing pending → nothing denied, read-only calls run while
  pending, the deny text, re-read via the CLI, actor union, fail closed /
  open, 100 KB command, warn mode; from 386db8c: `backoff`, `offline`,
  `substop_pending`, plus `backoff_broken` and `ack`; from hardening-live:
  `tamper_block|event|garbage`, `actor_unnamed`, `claude_config_dir`,
  `unavailable_first`) runs from
  `tests/stress.test.mjs` against the real kronicle-lite 0.8.0.
- `tests/stress/bash-guard.sh` (round 1), `bash-guard2.sh` and
  `scope-guard.sh` (round 2) against the real sea-lite CLI (Linux), plus
  unit tests for the scope guard cache and advisory.
- `tests/stress/pulse-corpus.sh` (85 cases) and `pulse-corpus2.sh` (125)
  under 0.5.1 rules: no world-changing case reads as read-only, harmless
  reads stay read-only; run from `tests/push.test.mjs` with new
  `readonly.jq` unit tests.

## [0.5.0] — 2026-11-01

Version-bound reconciliation with kronicle-lite 0.8.0 (`pending`), per-agent
state for subagents, and a guard for Bash edits inside other sessions'
sea-lite claims. Works with kronicle-lite 0.5.0 – 0.7.0 as before (the
pending gate switches on when kronicle-lite reports `pending`).

### Added
- **Pending gate (kronicle-lite ≥ 0.8.0).** Delivered is not reconciled:
  every `orient` call now passes `--pending-actor <the agent's actor>`, and
  when the briefing carries `pending_count` the pulse denies world-changing
  commands while it is > 0, listing each item (document › heading, the
  version read → the current one, the diff, kronicle-lite's own resolve
  hint, notes derived from it). Re-reading the current version (recall,
  `kronicle://docs/<slug>`) clears it with no manual step; receiving the
  push or retrying the command never does. `pulse_mode: warn` still only
  warns; an integrity failure still blocks first. Against kronicle-lite
  ≤ 0.7.0 the 0.4.0 "retraction since the last look" logic stays in
  charge. The agent's actor: `kronicle_actor` / `CC_ANCHOR_KRONICLE_ACTOR`,
  else the kronicle server's `--actor` / `KRONICLE_LITE_ACTOR` in
  `.mcp.json` or `~/.claude.json`, else `local-agent` (the server default);
  per agent, an `actor_id` the agent itself passes to a kronicle-lite tool
  wins (subagents with their own actor are gated on their own reads).
- **One "still pending" reminder** (`push_reminder_after`, 15; 0 = off): a
  delivered change is never re-pushed, but if it is still pending that many
  tool calls later and no world-changing command was attempted meanwhile
  (the pulse would have shown it), the push adds one reminder line. A new
  pending episode after a re-read gets its own.
- **Per-subagent retraction cursors.** Subagent tool events carry
  `agent_id`; the push and the pulse now key their cursor, seq, stamp and
  pending files on the whole `agent_id` (`push/<sid8>.a-<agent_id>.*`, or a
  hash of the whole id when it is long or not filename-safe — never a
  prefix, so two subagents can't share a cursor; the main agent keeps
  `push/<sid8>.*`). A new `SubagentStart` hook seeds each subagent's cursor
  from the main agent's (a file copy, no kronicle-lite call), so a
  retraction that lands while subagents run reaches each subagent and the
  parent exactly once; before, whichever agent's tool call fired first
  consumed it for everyone. A subagent seen without a `SubagentStart` seeds
  lazily at its first tool call; `SubagentStop` drops its files unless the
  stop is blocked. Contract-tested with the real CLI (parent + two
  subagents, one retraction: 1/1/1).
- **Bash claimed-path guard** (`bash_guard`, auto = when this project has
  seen sea-lite claims or sea-lite is configured; `bash_guard_ttl` 30 s).
  The Edit/Write scope guard never sees `sed -i`, redirects, formatters or
  codegen run through Bash. Now the Bash `PreToolUse` stamps the call
  (per-call stamp file) and `PostToolUse` checks only the paths other
  sessions hold — from a cached `sea-lite board --json`,
  refreshed at most every `bash_guard_ttl` s and dropped on any `sea_*`
  result — with builtin `-ot` tests against that stamp. A changed, new or
  removed path is named at once with holder, ticket, title and expiry; one
  `git status --porcelain --ignored=matching` over just those paths first
  drops git-ignored output. Fail-open; contract-tested with the real
  sea-lite CLI.
  Hardened against the stress suite (agent-memory-bench
  stress/cca/bash-guard.sh, 13/13): change time as well as mtime (one
  `find -newer|-cnewer` per Bash call while a foreign claim exists), so
  `cp -p` / `cp -a`, `tar -x`, `mv` over a claimed file and `touch -r`
  back-dating are caught; one stamp per `tool_use_id` (overlapping calls);
  the claim cache is refreshed as soon as the sea-lite store file changes
  (a claim made seconds ago is seen); no walk budget — a `find` that times
  out falls back to `git status` over the claimed paths. No foreign claim:
  still no process.

### Fixed
- **macOS: no retractions at all with kronicle-lite 0.7.0 when the project
  path goes through a symlink** (`/var` → `/private/var`, a symlinked
  checkout). kronicle-lite 0.7.0 scopes retractions by a project key derived
  from the working directory; a `put` records `process.cwd()` (physical),
  the hook passed `$CLAUDE_PROJECT_DIR` literally, so the keys differed and
  every retraction was hidden. `orient` now gets the physical path
  (`pwd -P`). The Bash guard likewise rewrites sea-lite's physical project
  paths to the hook's spelling of the root.
- **Empty card at startup.** `InstructionsLoaded` renders the template card
  ("Project: (unset …)", "Goal: (unset …)", "- (none …)") before
  `SessionStart` runs, so every new session got that empty card injected.
  `SessionStart` (startup/resume/clear/fork) now stays silent while the card
  is still the untouched template; one real project, goal or invariant is
  enough to inject it, and `compact` always injects.

### Changed
- Tests: no assertion depends on wall-clock luck any more. The exact-tie
  test drives the clock with a test-only `CC_ANCHOR_TEST_NOW` (epoch
  seconds) instead of hoping no second boundary falls inside it (failed
  once on macOS CI: expected 0 spawns, got 1). The three wall-clock budget
  tests (PostToolUse < 50 ms, scope guard cached < 30 ms) are opt-in with
  `CC_ANCHOR_PERF_TESTS=1`; CI runs them in a separate non-blocking step
  and still prints the hook timings.

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
