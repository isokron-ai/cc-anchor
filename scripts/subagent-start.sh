#!/usr/bin/env bash
# cc-anchor — SubagentStart hook.
#
# Per-subagent retraction cursor (0.5.0): seed the new subagent's
# kronicle-lite cursor from its parent's (the main agent's), so a retraction
# that lands while subagents run is delivered to EACH of them and to the
# parent, exactly once each, instead of to whichever agent's tool call
# happened to fire first. Subagent tool events carry `agent_id`; the push
# and the pulse key their cursor files on it (<run>/push/<sid8>.a-<agent_id>, or a hash of the whole id).
#
# Inert unless the retraction push is on (kronicle-lite configured). No
# kronicle-lite process: the seed is a file copy. Silent; exit 0 always.
#
# Input (stdin, per hooks reference "SubagentStart input"):
#   { session_id, transcript_path, cwd, hook_event_name:"SubagentStart",
#     agent_id, agent_type }
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input=""
IFS= read -r -d '' input || true
[[ -n "$input" ]] || exit 0
IFS=$'\x1f' read -r cwd sid agent < <(jq -r '[(.cwd // ""), (.session_id // ""), (.agent_id // "" | tostring)] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0
[[ -n "${agent:-}" ]] || exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_kl_session "$sid" "$agent"
[[ -e "$CC_KL_S.off" ]] && exit 0
cc_kl_enabled || exit 0
cc_kl_seed || true
exit 0
