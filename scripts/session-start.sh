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
# 0.2.0 additions:
#   * stamps state.compact_injected_at on source=compact (the
#     InstructionsLoaded(compact) hook checks it: if this hook did not run
#     for the latest compaction, the next prompt re-asserts the card);
#   * surfaces pending sea-lite releases (claims a stopped subagent or a
#     removed worktree left behind) as explicit sea_release calls;
#   * on resume/fork, relays the reference's cost fields
#     (seconds_since_last_response, prompt_cache_likely_expired) as a drift
#     signal — a free "your notes are N hours old" line.
#
# Why no `type: "mcp_tool"` orient here: that hook type exists and can call
# get_system_state, but (1) Claude Code skips mcp_tool hooks on SessionStart
# at launch (no MCP client yet) — they only run on compact/clear; (2) its
# `input` can template only `${fields}` of the hook's own JSON input, and the
# cursor lives on disk, so since_cursor cannot be passed; (3) the result is
# not a model tool call, so PostToolUse never sees the new cursor. The shell
# path below stays primary; `anchor.mjs hooks install orient-mcp --server X`
# adds an optional cold-orient mcp_tool hook for compact|clear in settings.
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
IFS=$'\x1f' read -r source_kind cwd secs cache_expired sid < <(jq -r '[(.source // "startup"), (.cwd // ""), ((.seconds_since_last_response // "") | tostring), ((.prompt_cache_likely_expired // "") | tostring), (.session_id // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || { source_kind=startup; cwd=""; secs=""; cache_expired=""; sid=""; }
source_kind="${source_kind:-startup}"

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"

# 0.4.0 retraction push: start this session's kronicle-lite cursor at the
# current head, so the first PostToolUse already knows what is "new". Kept
# across compaction / resume (the cursor is per session). Silent; bounded by
# push_timeout; fail-open.
cc_kl_session "$sid"
if [[ ! -s "$CC_KL_B.cursor" ]] && cc_kl_enabled; then cc_kl_init || true; fi

if [[ "$source_kind" != "compact" ]] && cc_card_blank; then
  # Nothing to anchor on yet (no card, or only the template InstructionsLoaded
  # rendered: "Project: (unset …)"); stay silent rather than inject an empty
  # card on every startup.
  exit 0
fi

# Make sure the generated section (cursor/compacted/refreshed) is current.
cc_render
if [[ "$source_kind" == "compact" ]]; then cc_state_set compact_injected_at "$(cc_now)" compact_injected_count "$(cc_state_get compact_count)" reassert_pending 0; fi

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

if [[ "$source_kind" == "resume" || "$source_kind" == "fork" ]] && [[ -n "${secs:-}" && "$secs" =~ ^[0-9]+$ ]]; then
  ctx="${ctx}
- Resumed after $(( secs / 60 )) min idle${cache_expired:+ (prompt cache likely expired: ${cache_expired})}: every state-claim in the resumed transcript is as-of then; re-read files before acting on them."
fi

pending="$(cc_pending_live)"
if [[ -n "$pending" && "$pending" != "[]" ]]; then
  ctx="${ctx}

Pending sea-lite releases (claims left behind by a stopped subagent or removed worktree; still live). Release them before taking new work:
$(cc_claims_lines "$pending")"
fi

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
