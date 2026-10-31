# cc-anchor

**A Claude Code plugin whose anchor card survives context compaction.**

After a compaction Claude Code re-reads a summary and quietly forgets the
invariants that were at the top of the conversation: the goal, the "never do
X" rules, the files it was in the middle of. cc-anchor keeps a ≤ 25-line
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
| `SessionStart` | `startup\|resume\|clear\|fork` | Injects the card if one exists, under a `session start` header. Silent otherwise. |
| `PostToolUse` | `*` | Appends `{ts, tool, target}` to a rolling trail and re-renders the card's last-5 section. One `jq` call, ~10–20 ms. Captures the cursor from any `mcp__*__get_system_state` result. |
| `UserPromptSubmit` | — | The bare word `anchor` re-injects the card. Everything else passes through. |
| `Stop` | — | Rotates the trail; once per 30 min, a one-line nudge when the goal is > 45 min stale (`CC_ANCHOR_STOP_WARN=0` to disable). |

All hooks fail open: missing `jq`, unwritable disk, malformed input → exit 0,
no output, nothing blocked.

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

Set them in your shell before launching `claude`, or in `settings.json` `env`.

## Development

```sh
npm test                    # node:test, 42 tests, no dependencies
npm run lint                # shellcheck + node --check
npm run validate            # claude plugin validate --strict --profile directory .
```

Layout: `hooks/hooks.json` → `scripts/*.sh` (bash + jq, fail-open) →
`scripts/render.jq` (the one renderer) ← `scripts/anchor.mjs` (CLI, edits
the top section only) ← `skills/anchor/SKILL.md` (the slash command and the
discipline). Tests feed the scripts the exact JSON shapes from the Claude
Code hooks reference (`tests/fixtures/`).

## License

Apache-2.0 © Joshua Bryan. See `LICENSE` and `NOTICE`.

---

Product: https://isokron.ai · Built off-grid in Cochise County, AZ by a laid-off support engineer — https://theexiledentrepreneur.com
