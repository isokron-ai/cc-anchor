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
exit 0
