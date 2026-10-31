#!/usr/bin/env bash
# cc-anchor — SessionStart hook (matcher "startup|resume|clear|compact|fork").
#
# RESTORE side of the compaction bracket. On source=compact the card is
# re-injected at the top of the fresh context under the header
# "ANCHOR — verbatim, read before anything else", followed by the
# reconciliation discipline and — only when a kronicle-lite MCP server is
# configured AND a cursor is on disk — the since_cursor instruction.
# On other sources the card (if one exists) is injected under a softer
# header so a resumed/forked/cleared session also starts anchored.
#
# Input (stdin, per hooks reference "SessionStart input"):
#   { session_id, transcript_path, cwd, hook_event_name:"SessionStart",
#     source:"startup"|"resume"|"clear"|"compact"|"fork", model?, … }
# Output (stdout, per "SessionStart decision control"):
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
# Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
source_kind="$(jq -r '.source // "startup"' <<<"$input" 2>/dev/null || echo startup)"
cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null || true)"

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"

if [[ "$source_kind" != "compact" && ! -s "$CC_CARD" ]]; then
  # Nothing to anchor on yet; stay silent rather than nag on every startup.
  exit 0
fi

# Make sure the generated section (cursor/compacted/refreshed) is current.
cc_render

card=""
[[ -s "$CC_CARD" ]] && card="$(cat "$CC_CARD")"

if [[ "$source_kind" == "compact" ]]; then
  header="ANCHOR — verbatim, read before anything else"
else
  header="ANCHOR — session start (${source_kind}); verbatim card from disk"
fi

if [[ -z "$card" ]]; then
  card="(no anchor card on disk at ${CC_CARD}. A compaction just happened with nothing anchored. Create one: /cc-anchor:anchor set goal \"…\")"
fi

discipline='Reconciliation discipline (cc-anchor):
- The card above was written to disk before compaction; it is authoritative over the compaction summary.
- Every state-claim that comes only from the summary is "as-of before compaction — verify against the file system or a tool result before acting".
- A summary claim that conflicts with the card, the files, or a fresh tool result is RETRACTED, not historical: do not reuse it as a premise, and say so once.
- Honor the invariants verbatim. If the goal changed, update the card: /cc-anchor:anchor set goal "…"'

ctx="${header}
${card}

${discipline}"

if cc_kronicle_configured; then
  if cursor="$(cc_detect_cursor)"; then
    ctx="${ctx}
- kronicle-lite is configured: call get_system_state with since_cursor=${cursor} before material work, reconcile its retractions, then carry the returned cursor forward."
  else
    ctx="${ctx}
- kronicle-lite is configured but no cursor is on disk: call get_system_state (cold) before material work and carry the returned cursor forward."
  fi
fi

cc_emit_context SessionStart "$ctx"
exit 0
