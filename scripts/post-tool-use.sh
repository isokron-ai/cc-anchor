#!/usr/bin/env bash
# cc-anchor — PostToolUse hook (matcher "*").
#
# Appends one breadcrumb {ts, tool, target, session} to the rolling trail
# and re-renders the card's trail section. Budget: < 20 ms. The whole
# payload goes to render.jq in ONE jq call; bash does the rest with
# builtins (plus `tail` and `mv`).
#
# Input (stdin, per hooks reference "PostToolUse input"):
#   { session_id, cwd, hook_event_name:"PostToolUse", tool_name,
#     tool_input:{…}, tool_response:{…}, tool_use_id, duration_ms? }
# Output: nothing on stdout (empty stdout = "plain text / nothing" =>
#         success, no decision). Exit 0 always.
#
# Extra, WITH kronicle-lite: when the tool is mcp__*__get_system_state the
# cursor in tool_response is captured to <run>/cursor so SessionStart can
# re-present it as since_cursor after the next compaction.
#
# Extra, WITH sea-lite (0.2.0): when the tool is mcp__*__sea_{claim,next,
# create,release,transition,refresh} the claim tokens in tool_response are
# folded into <run>/claims.json (scripts/claims.jq), keyed by ticket and
# tagged with the agent_id the hook fired in. That file is what the Stop /
# SubagentStop guards and the pending-release surfacing read. The branch is
# a bash regex on tool_name, so every other tool call pays nothing.
#
# Extra, WITH sea-lite (0.3.0): lease heartbeat. At most once a minute per
# session, `sea-lite heartbeat --session <session_id>` runs in the
# background and renews the session's live claims (cc_sea_heartbeat), so a
# task longer than one lease keeps its lock. When not due: builtins only.
#
# Extra, WITH kronicle-lite (0.4.0): retraction push (cc_kl_push, config
# `push`, auto = on when kronicle-lite is configured). New retractions since
# this session's cursor are injected next to the tool result:
#   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}
# Hot path when the store has not changed: two builtin mtime tests. Otherwise
# one or two bounded `kronicle-lite orient --json` calls; fail-open.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input=""
IFS= read -r -d '' input || true
[[ -n "$input" ]] || exit 0

# Root: Claude Code exports CLAUDE_PROJECT_DIR to hook processes; fall back
# to the payload's cwd (bash regex, no extra process) then $PWD.
root="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$root" && "$input" =~ \"cwd\":[[:space:]]*\"([^\"]*)\" ]]; then root="${BASH_REMATCH[1]}"; fi
cc_resolve "${root:-$PWD}"

cc_render "$input"
cc_claims_update "$input"
cc_sea_heartbeat "$input"
cc_kl_push "$input"
[[ -n "$CC_KL_CONTEXT" ]] && cc_emit_context PostToolUse "$CC_KL_CONTEXT"
exit 0
