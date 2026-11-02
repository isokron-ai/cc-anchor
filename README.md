# cc-anchor

**A Claude Code plugin whose anchor card survives context compaction.**

Claude Code reloads CLAUDE.md after a compaction, but what you settled *in the
conversation* only survives as a summary: the session goal, the "never do X"
rules you added along the way, the files it was in the middle of. cc-anchor keeps a ≤ 25-line
**anchor card** on disk, refreshes its breadcrumbs on every tool call, writes
it out on `PreCompact`, and re-injects it **verbatim, at the top of the fresh
context** on `SessionStart(compact)` — with a reconciliation discipline that
tells Claude to treat the summary as *as-of before compaction* and to mark
stale claims **RETRACTED**. A one-line status line shows the goal, how many
tool calls happened since the last compaction, and how stale the card is.

```
⚓ Ship cc-anchor v0.1.0 · 14 since compact · drift: 52m ⚠
```

Works without kronicle-lite. With it, the card carries your `get_system_state`
cursor across the compaction and the injection tells Claude to re-present it
as `since_cursor` before material work.

**0.2.0 adds the lifecycle hooks pack**: sea-lite claim tracking with a
Stop / SubagentStop guard ("release or hand off your claim first"), a
kronicle-lite session document on every Stop, a PreToolUse scope guard, a
Claude Code task → sea-lite ticket mirror, an InstructionsLoaded stamp, an
opt-in worktree pack, and a Cursor port. Everything beyond the card is
**opt-in** (`cc-anchor.json` / `CC_ANCHOR_*`) and inert for users without
kronicle-lite or sea-lite. See [Lifecycle hooks pack](#lifecycle-hooks-pack).
**0.3.0** makes the scope guard actually deny (it speaks sea-lite 0.4.0's
real contract, tested against the real CLI) and tells two Claude Code
sessions with the same actor apart, adds a lease heartbeat, and stops the
`Stop` guard from mixing up sessions.
**0.4.0** pushes kronicle-lite retractions into the agent's context after
every tool call and checks them again right before a world-changing Bash
command (`deploy`, `migrate`, `git push` …) — see
[Retraction push and pulse](#retraction-push-and-pulse-kronicle-lite).
**0.5.0** makes the pulse version-bound with kronicle-lite 0.8.0: a change
blocks world-changing commands until the agent has re-read its current
version (receiving it doesn't count), gives every subagent its own cursor,
and warns when a Bash command changes files inside another session's
sea-lite claim — see [Pending](#pending-kronicle-lite--080).
**0.5.1** stops trying to spot dangerous commands in shell text: while a
change is pending only provably read-only Bash calls run, and while nothing
is pending nothing is denied — see [The gate](#the-gate-pretooluse-bash).

## Install

```sh
claude plugin marketplace add rafe-walker/cc-anchor
/plugin install cc-anchor@cc-anchor
```

Requirements: `bash` and `jq` on `PATH` (the hooks), Node ≥ 18 (the
`/cc-anchor:anchor` command only). No npm dependencies at runtime. Linux and
macOS; Windows needs Git Bash.

Local checkout instead of GitHub:

```sh
claude plugin marketplace add /path/to/cc-anchor
claude plugin install cc-anchor@cc-anchor
```

## 30-second demo

```sh
cd your-project
claude
```

Inside the session:

```
/cc-anchor:anchor set project "Payments service — Go, Postgres, Stripe"
/cc-anchor:anchor set goal "Migrate webhooks to the v2 signature scheme"
/cc-anchor:anchor add-invariant "never change the public API without a changelog entry"
/cc-anchor:anchor statusline install
```

Do some work (every tool call adds a breadcrumb), then:

```
/compact
```

The next turn starts with:

```
ANCHOR — verbatim, read before anything else
# ANCHOR — your-project
Project: Payments service — Go, Postgres, Stripe
Goal: Migrate webhooks to the v2 signature scheme
Invariants:
- never change the public API without a changelog entry
<!-- cc-anchor:trail -->
Trail (last 5 tool calls, newest first):
- 2026-10-31T23:04:52Z Edit internal/webhooks/verify.go
- 2026-10-31T23:04:50Z Read internal/webhooks/verify.go
- …
Compacted: 2026-10-31T23:05:01Z
Refreshed: 2026-10-31T22:41:10Z

Reconciliation discipline (cc-anchor):
- The card above was written to disk before compaction; it is authoritative over the compaction summary.
- Every state-claim that comes only from the summary is "as-of before compaction — verify … before acting".
- A summary claim that conflicts with the card, the files, or a fresh tool result is RETRACTED, not historical …
```

Type the bare word `anchor` at any time to re-inject the card mid-session.

`demo/demo.tape` records this flow with [vhs](https://github.com/charmbracelet/vhs);
`demo/headless-proof.sh` reproduces the compaction bracket non-interactively
with `claude -p --autocompact 100k` and prints every hook event.

## What it does

| Hook | Matcher | What cc-anchor does |
| :- | :- | :- |
| `PreCompact` | `manual\|auto` | Renders the card to disk, stamps `compacted_at`. Never blocks. |
| `SessionStart` | `compact` | Injects the card verbatim under `ANCHOR — verbatim, read before anything else`, then the discipline, then (kronicle-lite only) `call get_system_state with since_cursor=<cursor> before material work`. |
| `SessionStart` | `startup\|resume\|clear\|fork` | Injects the card if one exists and is not the untouched template, under a `session start` header. Silent otherwise. |
| `SubagentStart` | — | Seeds the subagent's own kronicle-lite retraction cursor from the parent's (kronicle-lite only; a file copy). |
| `PostToolUse` | `*` | Appends `{ts, tool, target}` to a rolling trail and re-renders the card's last-5 section. One `jq` call, ~10–20 ms. Captures the cursor from any `mcp__*__get_system_state` result. With kronicle-lite: pushes new retractions as `additionalContext` (two builtin mtime tests when nothing changed). |
| `UserPromptSubmit` | — | The bare word `anchor` re-injects the card. Everything else passes through — unless `InstructionsLoaded(compact)` found that the post-compaction injection did not run, in which case the card is re-asserted once with the next prompt. |
| `Stop` | — | Rotates the trail; once per 30 min, a one-line nudge when the goal is > 45 min stale (`CC_ANCHOR_STOP_WARN=0` to disable). With the pack: claim guard, session document. |
| `InstructionsLoaded` | `session_start\|compact\|nested_traversal\|path_glob_match\|include` | Stamps which CLAUDE.md / rules files were loaded (`Instructions:` line on the card) and arms the belt-and-braces re-assert after a compaction. Observe-only event. |
| `PreToolUse` | `Bash` | Gate (kronicle-lite only): while a change the agent read is pending re-read (or the store fails integrity), denies every Bash call that is not provably read-only; nothing pending = nothing denied. Inert and ~5 ms without kronicle-lite. |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | Scope guard (opt-in): denies an edit inside someone else's live sea-lite claim (another actor or another session). ~6 ms when off. Does not see Bash-tool edits. |
| `SubagentStop` | — | Releases, or queues the release of, every sea-lite claim the stopping subagent took (auto when sea-lite is configured). |
| `TaskCreated` / `TaskCompleted` | — | Task mirror (opt-in): native tasks → sea-lite tickets; completion gated on open predecessors. |

All hooks fail open: missing `jq`, unwritable disk, malformed input, missing
CLI → exit 0, no output, nothing blocked. Failures are written to
`.claude/cc-anchor/log`, never to stdout.

### The card

`.claude/anchor.md` in the project (any directory with `.git` or `.claude/`);
otherwise `~/.claude/cc-anchor/<sha1(path)[:12]>/anchor.md`. Runtime files
(`trail.jsonl`, `state.json`, captured `cursor`) live in
`.claude/cc-anchor/` — add that directory to `.gitignore`. The card itself is
small and safe to commit if you want the goal shared with your team.

Everything above `<!-- cc-anchor:trail -->` is yours: edit it by hand or with
the command. Everything below is regenerated on every tool call. A hand edit
resets the drift clock.

### The command

```
/cc-anchor:anchor                      show the card + status
/cc-anchor:anchor set goal "…"
/cc-anchor:anchor set project "…"
/cc-anchor:anchor add-invariant "never …"
/cc-anchor:anchor rm-invariant 2
/cc-anchor:anchor refresh              reset drift without changing text
/cc-anchor:anchor cursor               show the detected cursor + kronicle status
/cc-anchor:anchor statusline install   write the statusLine setting (asks before overwriting yours)
/cc-anchor:anchor doctor
```

`/anchor` also works while no other command claims that name. The same
surface is available from a shell:
`node ~/.claude/plugins/cache/cc-anchor/cc-anchor/<version>/scripts/anchor.mjs …`
(`claude plugin list` prints the exact path).

### The status line

`/cc-anchor:anchor statusline install` copies the script to
`~/.claude/cc-anchor/` (stable across plugin updates) and writes this to
`~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/you/.claude/cc-anchor/statusline.sh",
    "padding": 1,
    "refreshInterval": 60
  }
}
```

If you already have a status line the command stops and asks: `--append`
keeps yours on row 1 with the anchor on row 2; `--force` replaces it (the
previous value is saved and `statusline uninstall` restores it).

Format: `⚓ <goal, 40 chars> · <N> since compact · drift: <M>m`. Drift is the
age of the hand-edited section: yellow + ⚠ past 45 min, red past 90.
`CC_ANCHOR_DRIFT_WARN_MIN`, `CC_ANCHOR_GOAL_WIDTH`, `CC_ANCHOR_COLOR=0`.

## With kronicle-lite

[kronicle-lite](https://github.com/rafe-walker/kronicle-lite) gives an agent
an `orient` call (`get_system_state`) that returns exactly what changed since
its last cursor. The cursor is the one thing a compaction summary reliably
loses. cc-anchor:

1. captures the cursor from every `mcp__*__get_system_state` result
   (`PostToolUse`), and also reads `.cc-anchor-cursor`, `.sextant-cursor`
   (IsoKron breadcrumb JSON) or `.kronicle-cursor`;
2. prints it on the card as `Cursor: sxt1c.…`;
3. after a compaction — only when a kronicle-lite server or plugin is actually
   configured (`.mcp.json`, `~/.claude.json`, or an enabled `kronicle-*`
   plugin) — appends *call `get_system_state` with `since_cursor=<cursor>`
   before material work*.

Detection is file-based so the hooks stay fast; `/cc-anchor:anchor doctor
--probe` runs `claude mcp list` for a definitive answer.
`CC_ANCHOR_KRONICLE=1|0` overrides.

### Retraction push and pulse (kronicle-lite)

Orienting at session start is not enough. In a live-agent benchmark
(agent-memory-bench Track B, T1: the runbook's deploy target changes while
`./bin/build` runs) every *pull* setup deployed to the stale target in every
Haiku run — 0/36, including kronicle-lite with its orient skill — because
nothing made the agent ask again before `deploy`. Pushing the change into
the context closed the gap (10/10). 0.4.0 ships that push, plus a check right
before the command that matters. Both are **on automatically when
kronicle-lite is configured** and inert otherwise.

**Push (`PostToolUse`).** Each session keeps its own kronicle-lite cursor
(`.claude/cc-anchor/push/<sid8>.cursor`, started at the chain head on
`SessionStart`). After every tool call, if the store changed, the hook runs
`kronicle-lite orient --cursor <c> --focus retractions --json`, advances and
persists the cursor, and injects what landed next to the tool result:

```
cc-anchor: kronicle-lite changed while you were working — 1 retraction(s) since your last check (head seq 9). Anything you read before this may be stale:
- runbook › Runbook › Deploy (seq 9, supersession/behavioral): relied on "Deploy with ./bin/deploy --target staging-a." → now "Deploy with ./bin/deploy --target staging-b."; diff: Deploy with ./bin/deploy --target [-staging-a.-]{+staging-b.+}
Re-read the affected document (recall, or get_system_state with your cursor) and use the current text before you act on it.
```

What you relied on, what it says now, the word diff — at most six lines.
When kronicle-lite marks a retraction **cosmetic** (`cosmetic: true` or
`change_class: "cosmetic"`; a kronicle-lite feature in progress), it is
counted but not shown (`push_cosmetic` shows it) and never blocks. Without
that flag every retraction is treated as semantic.

#### The gate (`PreToolUse`, `Bash`)

0.5.0 looked for world-changing commands (`deploy`, `git push` …) in the
shell text and checked kronicle-lite before those. A hardening round found
that a shell has too many ways to hide one — `A=1; git push` crashed the
matcher and was allowed, `source ./deploy.sh`, `cat <(./deploy.sh)`,
here-doc tricks, `make -j release`, a 200 KB command that ran past the hook
timeout — while ordinary calls (`git checkout release/2.0`, `chmod +x
deploy.sh`) were false alarms. **0.5.1 turns the check around:**

- **Nothing pending** (and the store reads ok): every Bash call runs. No
  regex, no chain splitting, no one-liner denials.
- **Something pending** — kronicle-lite ≥ 0.8.0 reports `pending_count > 0`
  for any of the agent's actors (see [Pending](#pending-kronicle-lite--080)),
  or, with kronicle-lite ≤ 0.7.0, a blocking retraction has not reached the
  agent yet, or the store reports an integrity failure: every Bash call is
  **denied** unless it is provably **read-only**. The reason names each
  change (document › heading, the version read → the current one, the diff)
  and says that re-reading clears it.

Read-only means a list of simple commands joined by `&&` `||` `;` `|` or
newlines, each one of: `cat` `less` `head` `tail` `ls` `grep`/`egrep`/`fgrep`
`rg` `find` `wc` `diff` `jq` `stat` `basename` `dirname` `realpath` `pwd`
`which` `echo` `printf` `cd` `true`; `git status|log|diff|show|rev-parse|
ls-files|ls-tree|cat-file|blame|describe|merge-base|show-ref`, `git branch`
(listing only) and `git remote -v`; `kronicle-lite get|pending|orient|doctor|
verify-chain|keys` and `sea-lite board|list|show|whoami|stats|verify|doctor|
scope-check` (also as `npx [-y] <cli>[@ver]` or `node …/<cli>/dist/cli.js`).
Everything the parser (`scripts/readonly.jq`) does not fully understand is
**not** read-only: any other command or a path to one, an assignment, a
subshell or `{ }` group, `$( )` and backticks, `<( )` / `>( )`, `$'…'`,
`${…}` other than `${NAME}`, `$1` `$@` `$?`, here-docs and here-strings, `&`,
a redirection other than to `/dev/null` or an fd dup (`2>&1`), `find
-exec/-execdir/-ok/-delete/-fprint*`, `rg --pre`, `less -o/+cmd`, git global
options other than `-C`/`--no-pager`, `git … --output`, an unquoted
variable, glob or brace in the arguments of `find`/`rg`/`less`/`git` (it
could expand into an option), an unbalanced quote, or a call longer than
`pulse_max_bytes` (8192). Comments, quoting and line continuations are read
the way bash reads them. Re-reading through Bash works too:
`kronicle-lite get <slug> --actor <actor>` is itself read-only.

**Fail closed while pending, open otherwise.** If kronicle-lite cannot be
read (CLI crashing, past `push_timeout`) the gate decides on the last answer
it got: a change known to be pending still denies. When the store has
changed since that answer, the answer is stale: the gate re-reads even
inside the push's 60 s back-off, and if that fails too, every call that is
not read-only is denied ("kronicle-lite could not be read just now"). Only a
CLI that has never answered in this session fails open, and the first such
unchecked call is told so. A store kronicle-lite reports as damaged (an
integrity failure — also a rewrite that does not move the head — or an
unreadable, corrupt database) is not "unavailable": the push warns at once
and only read-only calls run. A classifier error counts as "not read-only". `pulse_mode: warn`
allows the call and adds the same text as context.

**Operator-only overrides.** `kronicle-lite shim ack`, `shim install` /
`uninstall` and `pending ack` clear or reconfigure kronicle-lite's own
exec-time gate without a re-read. When the agent runs one (any spelling)
the gate denies it, in any mode and whether or not anything is pending, and
tells it to re-read the pending items or ask the operator.

**What it does not catch** (out of scope; only an exec-time check — the
kronicle-lite PATH shims — or nothing can):

- anything while nothing is pending: the gate is about acting on stale
  reads, not about which commands are dangerous;
- a change that lands *during* a single Bash call (the push only fires
  between calls);
- shell state set up before the change became pending and used by an
  allowlisted name: a function or alias named `cat`/`ls`/`git` in the
  user's shell snapshot, an exported `GIT_*` / `LESSOPEN` / `RIPGREP_CONFIG_PATH`,
  a `.git/config` alias, pager, `diff.external` or fsmonitor hook;
- git indirection and quoted code that only an exec-time shim sees once
  nothing is pending (`git -c alias.x=push x`, `git submodule foreach 'git
  push'`, `git rebase -x …`, `watch`/`trap`/`tmux` strings, `xargs git`,
  Windows `git.exe` / `cmd /c` spellings) — while something is pending all of
  these are denied anyway, because none of them is read-only;
- deliberate bypasses of other guards: `git commit --no-verify`,
  `core.hooksPath=/dev/null`, `KRONICLE_SHIM_EXEC` tricks, editing the
  plugin's own files or `cc-anchor.json` (`pulse: off`) while nothing is
  pending.

**Cost and failure.** While `kronicle-lite.db` (and its `-wal`) are older
than the session's stamp, the push costs two builtin `-ot` tests and no
process. A change costs one read-only `orient --focus pulse` (head seq) and,
only if the head moved, one `orient --focus retractions`: ~0.5–1 s on a
laptop, once per change. Every CLI call is bounded by `push_timeout` (3 s);
a missing CLI, a timeout, a crash or unparsable output **fails open** — the
tool call runs, nothing is printed, one line goes to the log, and the CLI is
not retried for 60 s. If that lasts `push_offline_after` (20) consecutive
calls, the agent gets one advisory that the retraction feed is offline.
A store that answers but reports `integrity.ok: false` (corrupt or tampered
chain) is the opposite case: the push warns once per distinct problem, no
retractions are taken from it, and the gate lets only read-only Bash calls
run until a fresh read says the store is ok. The store is the one the kronicle-lite MCP server uses:
`kronicle_data_dir` / `CC_ANCHOR_KRONICLE_DATA_DIR`, else the server's
`--data-dir DIR` / `--data-dir=DIR` (or `KRONICLE_LITE_DATA_DIR` env) in
`.mcp.json` / `~/.claude.json`, else `$KRONICLE_LITE_DATA_DIR`, else
`~/.kronicle-lite`. The server is recognised by its command line (`npx
kronicle-lite …`, `node …/kronicle-lite/dist/cli.js`, `kronicle-lite serve`),
whatever its key in `mcpServers` (`"memory"` works), else by a key that names
kronicle; `~/.claude.json` `projects` is looked up under both the literal
project path and its physical (symlink-resolved) path.
The CLI is looked up like the other hooks do (`CC_ANCHOR_KRONICLE_LITE_BIN`,
`PATH`, the plugin cache, `node_modules`) and finally in the npx cache, where
the isokron-plugins `npx -y kronicle-lite@… serve` launch leaves it. Needs
kronicle-lite ≥ 0.5.0 (retraction diffs); tested against 0.5.0 and 0.6.0.

| Switch | Default | |
|---|---|---|
| `push` | auto | On when kronicle-lite is configured; `0` disables the push (the pulse follows unless set). |
| `push_timeout` | `3` | Seconds per kronicle-lite CLI call. |
| `kronicle_actor` | auto | The agent's kronicle-lite actor for `pending` (see Pending). |
| `push_reminder_after` | `15` | Tool calls a delivered change may stay pending before one reminder line; `0` never. |
| `push_offline_after` | `20` | Consecutive unreadable calls before one "retraction feed offline" advisory; `0` never. |
| `push_cosmetic` | off | Also list retractions kronicle-lite marks cosmetic. |
| `pulse` | auto | `0` disables the gate. |
| `pulse_mode` | `deny` | `warn`: allow, add the pending list as context. |
| `pulse_max_bytes` | `8192` | A longer Bash call is never read-only. |
| `pulse_match`, `pulse_chain` | — | Ignored since 0.5.1. |
| `kronicle_data_dir` | auto | Store to read (see above). |

#### Pending (kronicle-lite ≥ 0.8.0)

Delivery is not reconciliation: a pushed change can be skimmed, compacted
away or never acted on. kronicle-lite 0.8.0 tracks, per actor, every change
to something that actor read which it has **not re-read at the current
version** (`pending`). cc-anchor passes `--pending-actor <the agent's
actor>` on every `orient`, and when the briefing carries `pending_count`
the gate is on:

```
cc-anchor pulse: did NOT run `./bin/deploy --target stg-a` — 1 kronicle-lite change(s) you (actor local-agent) relied on are not re-read at their current version:
- runbook › Runbook › Deploy (seq 7, superseded/behavioral; you read it at seq 4): read "Deploy to stg-a." → now "Deploy to stg-b."; diff: Deploy to [-stg-a.-]{+stg-b.+} — recall it again or read kronicle://docs/runbook
Until you re-read them, only read-only Bash commands run (cat, less, head, …); this call is not one: `./bin/deploy` (a path to a program or script) is not on the read-only list.
Re-read each (recall, or kronicle://docs/<slug>): that clears this check by itself — receiving or acknowledging a change, retrying, or reading as another actor does not. …
```

- The gate is `pending_count > 0`; re-reading the current version clears it
  with no manual step. Retrying the command, or having been pushed the
  change, does not. `pulse_mode: warn` still only warns.
- The push never re-pushes a delivered change, but if it is still pending
  `push_reminder_after` (15) tool calls later and the gate has not shown it
  meanwhile, it adds **one** reminder line.
- The agent's actors: the configured one — `kronicle_actor` /
  `CC_ANCHOR_KRONICLE_ACTOR`, else the kronicle-lite server's `--actor ID` /
  `--actor=ID` (or `KRONICLE_LITE_ACTOR`) in `.mcp.json` / `~/.claude.json`,
  else `local-agent` (the server's default) — **plus every `actor_id` the
  agent has passed to any MCP tool** (any server key, plugin prefixes too).
  If no actor is named anywhere cc-anchor can read (a `--mcp-config` file or
  a plugin server is invisible to hooks; `$CLAUDE_CONFIG_DIR/.claude.json`
  is read), `local-agent` is only a guess: the 0.4.0 retraction rule then
  stays on as well, and the agent is told to set `CC_ANCHOR_KRONICLE_ACTOR`.
  The gate is on the union, per agent: a subagent that reads as its own
  actor is checked on those reads and on the shared server actor's, and
  naming another actor never clears what one of them has pending. The
  parent is not gated on a subagent's private actor. A stopped subagent's
  actors are kept, so a resumed one (same `agent_id`) is gated on them.
- With kronicle-lite ≤ 0.7.0 (no `pending` in the briefing) the 0.4.0 rule
  decides when the gate is on: a blocking retraction that has not reached
  the agent yet (the deny delivers it; the retry runs).

**Subagents** have their own cursors: subagent tool events carry
`agent_id`, a `SubagentStart` hook seeds the subagent's cursor from the main
agent's (a file copy), and each agent — parent and every subagent — is told
about a retraction exactly once, at its own next tool call. The gate's
state is per agent too.

Cursor has no post-tool context output, so the push is Claude Code-only for
now.

## Lifecycle hooks pack

Switches live in `.claude/cc-anchor.json` (project) or
`~/.claude/cc-anchor/config.json` (user); `CC_ANCHOR_<KEY>` in the
environment wins. `/cc-anchor:anchor config` shows the effective values;
`config set claim_guard true` writes the file. The hooks read the JSON with
bash pattern matching, so an unset switch costs no `jq` call.

| Key | Default | Hook | What it turns on |
| :- | :- | :- | :- |
| `claim_guard` | off | `Stop` | Block the stop **once** per claim set while `claims.json` shows a live sea-lite claim: `{"decision":"block","reason":"release or hand off your sea-lite claim first: … sea_release {ticket_id, claim_token, note}"}`. `stop_hook_active=true` always short-circuits, so the 8-continuation cap is never approached. |
| `session_doc` | off | `Stop` | `put_document` `session-<YYYY-MM-DD>-<sid8>` = anchor card + `last_assistant_message`, through the **kronicle-lite CLI** (`kronicle-lite put`, same SQLite store as the MCP server). Skipped when the message is unchanged. Runs in the background after the decision is printed. |
| `subagent_release` | auto | `SubagentStop` | When the stopping `agent_id` holds live claims: block once with the exact `sea_release` calls, and append them to `pending-release.jsonl`, which the next `SessionStart` / `anchor` re-ground prints as *Pending sea-lite releases*. Auto = on when sea-lite is configured. |
| `task_mirror` | off | `TaskCreated` / `TaskCompleted` | Mirror native tasks into sea-lite tickets (`kind: chore`, `status: triaged`, tags `cc-task`, `cc-task:<id>`, `idempotency_key: cc-task:<id>`); on completion claim + `sea_transition resolved`. Written through the sea-lite **library** (`scripts/task-mirror.mjs`). |
| `task_mirror_gate` | on | `TaskCompleted` | With `task_mirror`: exit 2 (completion refused, reason fed back to Claude) while the ticket `depends_on` a non-terminal ticket or a non-terminal ticket `blocks` it. |
| `scope_guard` | off | `PreToolUse` | Deny `Edit`/`Write`/`MultiEdit`/`NotebookEdit` inside someone else's live sea-lite claim — another actor, **or the same actor in another Claude Code session**. Needs sea-lite ≥ 0.4.0: runs `sea-lite scope-check --json --session <session_id> <absolute file>` and turns exit 1 + `{schema:"sea-lite.scope-check/1", conflicts:[{holder_label, ticket_id, title, held, claim_expires_at}]}` into `permissionDecision: "deny"` naming holder, ticket, title, locked paths and expiry. sea-lite maps the hook's `session_id` to the identity this session's MCP server claims under, so the session's own claims (main agent and subagents) never block it. A file outside any repository (`outside_repo`) or in another repository is allowed. Verdicts are cached per **session and path** for `scope_ttl` s (30); the cache is dropped whenever a `sea_*` result passes through PostToolUse and whenever the sea-lite store changes (a claim by anyone). Cached: ~20 ms; cold: one `sea-lite` spawn bounded by `scope_timeout` s (4). A missing binary, a sea-lite older than 0.4.0, a crash, a timeout or an `exit 2` other than `outside_repo` **fail open for that edit only** (never cached), are logged once, and the agent is told **once per outage** that the claim guards are not checking. **Bash-tool edits** (`sed -i`, redirects, formatters) never reach this hook; install sea-lite's git guard (`sea-lite precommit --install`) as the backstop. |
| `heartbeat` | auto | `PostToolUse` | Keep this session's sea-lite leases alive while it works: at most once per `heartbeat_interval` s (60) per session, `sea-lite heartbeat --session <session_id>` runs in the background and renews every live claim of the session by its own lease (a lapsed one is never revived). Auto = on once this project has seen a claim or sea-lite is configured — no setup needed (agent-memory-bench Track A S13: without it a lease lapsed mid-task 3/3; with it 3/3 survived). When not due it costs one builtin file read. |
| `bash_guard` | auto | `PreToolUse` / `PostToolUse` (Bash) | After a Bash call, name every path inside a live sea-lite claim held by **another session** that the call changed, created or removed — holder, ticket, title, expiry — as context next to the tool result. Covers what the Edit/Write scope guard cannot see (`sed -i`, redirects, formatters, codegen, `cp -p`, `tar -x`, `mv`, `touch -r`). The `PreToolUse` stamps each call separately (`<sid8>.pre.<tool_use_id>`, so parallel calls don't clobber each other); `PostToolUse` runs one `find <claimed paths> -newer\|-cnewer <stamp>` — change time as well as modification time, so mtime-preserving writes count. The claimed paths come from a cached `sea-lite board --json`, refreshed after `bash_guard_ttl` s (30), whenever the sea-lite store file is newer than the cache (a new claim by anyone), and after any `sea_*` result. No foreign claim = no process; a hit adds one `git status` to drop git-ignored files (unless the claim itself is on an ignored path); a `find` that times out falls back to `git status` over the claimed paths. A claimed path removed through its parent (`rm -rf src`, `mv src x`, a checkout without `src/`) is reported when it existed before the call. A board call that fails keeps the last good claims in use, is retried after 5 s (at once when there are none), and the agent is told once per outage. After a call that starts background work (`… &`, `nohup`, `setsid`, `disown`), claimed paths that change after it returned are reported at the following tool calls (for 10 minutes). A claim of the agent's own session taken by a different agent of it (a subagent editing the main agent's or a sibling's claim; known from the `sea_*` results) is reported too. Advisory: the change already happened. A write landing within one kernel timestamp tick (a few ms) of the `PreToolUse` stamp shares its timestamp and is missed; real Bash calls start later than that. Auto = on once this project has seen a claim or sea-lite is configured. |
| `sea_session` | — | `PreToolUse` / `PostToolUse` | Act as this sea-lite session instead of the hook's `session_id`. Claude Code needs nothing here. **Cursor**: Cursor's conversation id is not the MCP server's session, so start the server with a fixed one (`serve --session cursor-main`) and set `CC_ANCHOR_SEA_SESSION=cursor-main`; otherwise the guard cannot tell the agent's own claims from others' and denies them. |
| `sea_actor` | — | `PreToolUse` / `PostToolUse` | Pass `--actor` too: then only that actor's claims in the session count as the hook's own (default: every claim of the session). |

Detection: sea-lite is "configured" when `.mcp.json`, `~/.claude.json` or an
enabled `sea-lite*` plugin mentions it (`CC_ANCHOR_SEA=1|0` overrides), same
as kronicle-lite. The CLIs are found via `CC_ANCHOR_KRONICLE_LITE_BIN` /
`CC_ANCHOR_SEA_LITE_BIN`, then `PATH`, then the plugin cache
(`~/.claude/plugins/cache/*/<name>/*/node_modules/<name>/dist/cli.js`, which is
where the isokron plugins pin the packages). `/cc-anchor:anchor doctor` prints
what it found.

### Claim tracking

Hooks cannot call MCP tools, but they see every MCP result. The PostToolUse
hook matches `^mcp__.*__sea_(claim|next|create|release|transition|refresh)$`
(a bash regex — every other tool call pays nothing) and folds the result into
`.claude/cc-anchor/claims.json` with one `jq` run of `scripts/claims.jq`:

| Tool result | Effect on `claims[ticket_id]` |
| :- | :- |
| `sea_claim` → `{claims:[{ticket_id, claim_token, expires_at}]}` | add each |
| `sea_next` → `{ticket:{id}, claim_token, expires_at}` | add when `ticket` is not null |
| `sea_create` with `claim_seconds` → `{ticket:{id}, claim_token, claim_expires_at}` | add when `claim_token` is not null |
| `sea_refresh` → `{expires_at}` | bump `expires` |
| `sea_release` (input `ticket_id`) | drop — ids may be ≥ 8-char prefixes, so prefix match |
| `sea_transition` with `to` ∈ `resolved\|wont_fix\|duplicate\|dropped\|merged` | drop (terminal states release the claim) |
| any result carrying `error` | no change |

Each entry records `agent_id` (the common input field Claude Code sets inside
a subagent), `session_id`, `cwd` (so a removed worktree can find its claims)
and the lease expiry; expired entries are dropped on every update and never
count as live. `/cc-anchor:anchor claims` lists them. `claims.json` is per
project, shared by every Claude Code session in it, so the `Stop` guard
only considers the stopping session's own claims (0.3.0; before, a second
session was shown — and handed the tokens of — the first one's claims).

### `type: "mcp_tool"` hooks — what the reference allows

The hooks reference documents `{"type":"mcp_tool","server":…,"tool":…,"input":{…}}`
and we checked whether the orient step could be that hook instead of shell
glue. It cannot, for three documented reasons:

1. `SessionStart` **at launch** (and `--continue`/`--resume`) fires before MCP
   servers exist; Claude Code skips `mcp_tool` hooks there and logs
   `mcp_tool hooks are not available for the 'SessionStart' hook event`. They
   run only on the `compact` / `clear` re-fire.
2. `input` string values template only `${path}` fields **of the hook's own
   JSON input**. The cursor is on disk, not in the SessionStart payload, so
   `since_cursor` cannot be passed — the call would always be a cold orient.
3. The call is not a model tool call, so PostToolUse never sees the returned
   cursor, and the `server` name is per-user (`kronicle-lite` for a user
   server, `plugin:kronicle-lite:kronicle-lite` for the plugin-bundled one);
   a plugin cannot ship one without producing a hook error for everyone whose
   server has another name or none.

So the shell path stays primary. If you want the cold briefing injected
automatically after compactions anyway:

```
/cc-anchor:anchor hooks install orient-mcp --server kronicle-lite
```

writes this to `~/.claude/settings.json` (matcher `compact|clear`, the tool's
text output is added to context exactly like command-hook stdout):

```json
{ "type": "mcp_tool", "server": "kronicle-lite", "tool": "get_system_state",
  "input": { "focus": "orientation", "budget_tokens": 1500 }, "timeout": 30 }
```

The same limits rule out `mcp_tool` for `sea_release` on SubagentStop (the
token is not in the input) and for `sea_transition` on TaskCompleted (ticket id
and token are not in the input), which is why those go through the queue file
and the library respectively.

### Belt and braces after a compaction

`SessionStart(compact)` is the only event with a context channel after a
compaction: `InstructionsLoaded` has none (its JSON is discarded),
`PostCompact` discards output, `PreCompact` can only block. So
`SessionStart(compact)` stamps `compact_injected_count` in `state.json`;
`InstructionsLoaded(compact)` compares it with `compact_count` (counts, not
timestamps — all three hooks can land in the same second) and, if the
injection did not happen (a timed-out hook, a failed hook group, a race),
sets `reassert_pending`. The next `UserPromptSubmit` injects the card once
under `ANCHOR — verbatim … (re-asserted …)` and clears the flag.

Measured on Claude Code 2.1.316: a **plugin's** `InstructionsLoaded` hook does
not fire for `load_reason: session_start` (the eager CLAUDE.md load precedes
plugin registration, the ordering the reference also documents for
`WorktreeCreate` with `--tmux`); a settings-file hook does. Lazy loads
(`nested_traversal`, `path_glob_match`, `include`) reach the plugin hook, so the
matcher includes them and the `Instructions:` line on the card lists what was
loaded lazily. To stamp the eager load too, copy the hook into
`~/.claude/settings.json`.

### Worktree pack (opt-in, not in `hooks.json`)

A `WorktreeCreate` hook *replaces* Claude Code's git behaviour entirely and
must print the created path or creation fails — a plugin that registered it
for everyone would hijack every `--worktree`, `EnterWorktree` and
`isolation: "worktree"` call. So it is a pack you install into settings:

```
/cc-anchor:anchor hooks install worktree
```

`worktree-create.sh` reproduces the documented default (`.claude/worktrees/<name>`
on branch `worktree-<name>` from `HEAD`, `.worktreeinclude` copies), then adds a
`WorktreeCreate <name>` breadcrumb, records the worktree in `state.json` and
copies the card into the worktree's `.claude/` so a session launched inside
it is anchored too. `worktree-remove.sh` queues a pending release for every
live claim taken while `cwd` was inside the worktree, removes the directory
(`git worktree remove --force`, then `rm -rf`) and deletes the branch, as the
reference asks. `cwd` follows Claude into the worktree while
`$CLAUDE_PROJECT_DIR` — and the card — stay in the main checkout.

### Runtime files

`.claude/cc-anchor/` gains `claims.json`, `pending-release.jsonl`,
`scope-cache.json`, `tasks.json` (task id → ticket id), `push/` (per-agent
kronicle-lite cursor, head seq, mtime stamp, pending retractions),
`bashguard/` (claimed-path cache, per-session Bash stamps), `log` and
`once/` (rate-limit latches). All regenerable; keep the directory in `.gitignore`.

## Cursor

Cursor's hooks (`.cursor/hooks.json`, `version: 1`) speak a different dialect:
`workspace_roots[]` instead of a project dir, `tool_output` as a JSON string,
MCP tools named `MCP:<tool>`, `stop` answered with `followup_message`,
`sessionStart` with `additional_context`. `cursor/adapter.sh` rewrites each
Cursor payload into the Claude Code shape, runs the same scripts, and rewrites
the answer back.

Install (project scope — the file is meant to be committed; `--scope user`
writes `~/.cursor/hooks.json` and runs from `~/.cursor/`):

```sh
node ~/.claude/plugins/cache/cc-anchor/cc-anchor/0.5.1/scripts/anchor.mjs cursor install
# or from a checkout: node /path/to/cc-anchor/scripts/anchor.mjs cursor install
```

This copies `adapter.sh` + `scripts/` to `.cursor/hooks/cc-anchor/` and merges
these entries into `.cursor/hooks.json` (existing hooks are kept):

| Cursor event | → script | Notes |
| :- | :- | :- |
| `sessionStart` | `session-start.sh` (source `startup`) | card injected as `additional_context` |
| `preCompact` | `pre-compact.sh` | card written, `compacted_at` stamped |
| `postToolUse` | `post-tool-use.sh` | trail + claim tracking; `MCP:sea_claim` → `mcp__cursor__sea_claim` |
| `preToolUse` (matcher `Write`) | `pre-tool-use.sh` | scope guard → `{"permission":"deny","agent_message":…}`; set `sea_session` (see the pack table) |
| `stop` (`loop_limit: 2`) | `stop.sh` | `decision: block` → `followup_message`; `loop_count > 0` → `stop_hook_active` |
| `subagentStop` (`loop_limit: 2`) | `subagent-stop.sh` | see gaps |

Reload the Cursor window; `cursor uninstall` removes only our entries.

**Parity gaps** (from Cursor's reference): there is no post-compaction
session-start, so the card cannot be re-injected automatically after a
compaction — `preCompact` writes it and the next `sessionStart` (new
conversation) injects it; `beforeSubmitPrompt` has no context output, so the
bare word `anchor` cannot re-ground; `subagentStop` carries no subagent id,
so claims cannot be attributed to the stopping subagent (the adapter runs the
hook with an empty id and it stays silent); `stop` carries no assistant
text, so the session document holds the card only; `InstructionsLoaded`,
`TaskCreated/Completed` and the worktree events have no Cursor equivalent.
Plugin hooks in Cursor are command-only, which is all we use.

## Why not just a PreCompact hook that writes SESSION.md?

Because the hooks reference gives `PreCompact` no context channel — only
`decision: "block"` — and `SessionStart(compact)` text is injected but nothing
makes Claude re-read a file it points at (see
[anthropics/claude-code#43733](https://github.com/anthropics/claude-code/issues/43733)).
cc-anchor therefore puts the *content*, not a pointer, into the injection,
keeps it short enough to survive verbatim, and pairs it with a discipline that
demotes the summary. The breadcrumbs are what let Claude re-open the right
files instead of guessing.

## Configuration

| Variable | Default | Meaning |
| :- | :- | :- |
| `CC_ANCHOR_TRAIL_N` | `5` | Breadcrumbs shown on the card |
| `CC_ANCHOR_DRIFT_WARN_MIN` | `45` | Minutes before the drift segment / Stop nudge warns |
| `CC_ANCHOR_DIR` | — | Put the card and runtime files in this directory |
| `CC_ANCHOR_HOME` | `0` | `1` forces the `~/.claude/cc-anchor/<hash>/` store |
| `CC_ANCHOR_KRONICLE` | auto | `1`/`0` forces kronicle-lite detection |
| `CC_ANCHOR_STOP_WARN` | `1` | `0` disables the Stop-hook nudge |
| `CC_ANCHOR_COLOR` | `1` | `0` disables ANSI colour in the status line |
| `CC_ANCHOR_SEA` | auto | `1`/`0` forces sea-lite detection |
| `CC_ANCHOR_CLAIM_GUARD`, `…_SESSION_DOC`, `…_SUBAGENT_RELEASE`, `…_TASK_MIRROR`, `…_TASK_MIRROR_GATE`, `…_SCOPE_GUARD`, `…_SCOPE_TTL`, `…_SCOPE_TIMEOUT`, `…_HEARTBEAT`, `…_HEARTBEAT_INTERVAL`, `…_SEA_SESSION`, `…_SEA_ACTOR`, `…_PUSH`, `…_PUSH_TIMEOUT`, `…_PUSH_COSMETIC`, `…_PUSH_OFFLINE_AFTER`, `…_PULSE`, `…_PULSE_MATCH`, `…_PULSE_MODE`, `…_PULSE_CHAIN` | see the pack / push tables | Environment form of the `cc-anchor.json` switches |
| `CC_ANCHOR_KRONICLE_LITE_BIN`, `CC_ANCHOR_SEA_LITE_BIN` | auto | Path to the CLI (binary or `dist/cli.js`) |
| `CC_ANCHOR_KRONICLE_DATA_DIR` | — | `--data-dir` for `kronicle-lite put` and the retraction push (default: detected from the kronicle MCP server, else `~/.kronicle-lite`) |
| `CC_ANCHOR_SEA_MODULE`, `CC_ANCHOR_SEA_DATA_DIR` | auto | sea-lite package path / data dir for the task mirror, the scope guard and the heartbeat (`--data-dir`; `KRONICLE_LITE_DATA_DIR` is honoured too) |
| `CC_ANCHOR_SYNC` | `0` | `1` runs the session-document put and the heartbeat inline instead of in the background (tests) |

Set them in your shell before launching `claude`, or in `settings.json` `env`.

## Development

```sh
npm i --no-save --no-package-lock sea-lite@^0.4.0 kronicle-lite@0.8.0   # real CLIs for the contract tests
npm test                    # node:test, 142 tests (files run one at a time: timing budgets)
npm run lint                # shellcheck + node --check
npm run validate            # claude plugin validate --strict --profile directory .
```

Layout: `hooks/hooks.json` → `scripts/*.sh` (bash + jq, fail-open) →
`scripts/render.jq` (the one renderer) + `scripts/claims.jq` (the claim state
machine) + `scripts/retractions.jq` / `scripts/readonly.jq` (retraction lines,
the gate's read-only classifier) ← `scripts/anchor.mjs` (CLI, edits the top section only, installs
the packs) ← `skills/anchor/SKILL.md` (the slash command and the discipline).
`scripts/task-mirror.mjs` is the only hook that needs Node (task mirror,
opt-in). `cursor/` holds the Cursor adapter. Tests feed the scripts the exact
JSON shapes from the Claude Code hooks reference and Cursor's hooks page
(`tests/fixtures/`); `tests/fixtures/fake-sea-lite/` is a file-backed double
of the sea-lite library surface the mirror uses, and the same test also runs
against the real package when it is installed. `tests/sea-contract.test.mjs`
and `tests/kronicle-contract.test.mjs` drive the hooks against the real
sea-lite and kronicle-lite CLIs and fail (not skip) when they are missing.

Headless proofs: `demo/headless-proof.sh` (the compaction bracket, 0.1.0)
and `demo/headless-proof-lifecycle.sh` (Stop claim guard + a tool call,
0.2.0) stream every `hook_response` from `claude -p --output-format
stream-json --verbose`.

## License

Apache-2.0 © Joshua Bryan. See `LICENSE` and `NOTICE`.

---

Product: https://isokron.ai · Built off-grid in Cochise County, AZ by a laid-off support engineer — https://theexiledentrepreneur.com
