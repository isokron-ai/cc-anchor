#!/usr/bin/env bash
# cc-anchor — SubagentStop hook (no matcher; runs for every agent_type,
# including the empty one Claude Code reports for its internal agents).
#
# Releases, or arranges the release of, every sea-lite claim the stopping
# subagent took. The claim tokens come from claims.json: the PostToolUse
# hook fires inside the subagent too and tags each sea_claim/sea_next result
# with the `agent_id` common input field, so "claims held by this subagent"
# is `agent == $agent_id`.
#
# Why not a `type: "mcp_tool"` hook calling sea_release directly? Its
# `input` only templates `${path}` values from the hook's own JSON input,
# and SubagentStop input carries agent_id but not the claim token, so the
# release cannot be expressed as a static hook (see README "mcp_tool hooks").
#
# What we do instead:
#   a. If stop_hook_active is false and we have not already blocked this
#      agent for this claim set: {"decision":"block","reason":…} listing
#      sea_release {ticket_id, claim_token} per claim. The subagent is still
#      alive and holds its MCP connection; it releases and stops again.
#      Latch: state.json subagent_block_<agent_id> = sorted ticket ids.
#   b. Always append the claims to pending-release.jsonl. The next
#      SessionStart / `anchor` re-ground in the parent prints them as
#      "Pending sea-lite releases" with the tokens, so the parent can call
#      sea_release itself if the subagent never did. Entries vanish once the
#      claim is released, transitioned to a terminal state, or expires.
#
# Config: `subagent_release` (auto: on when sea-lite is configured; set
# CC_ANCHOR_SUBAGENT_RELEASE=0 to disable).
#
# Input (stdin, per hooks reference "SubagentStop input"):
#   { session_id, transcript_path, cwd, permission_mode,
#     hook_event_name:"SubagentStop", stop_hook_active, agent_id, agent_type,
#     agent_transcript_path, last_assistant_message, background_tasks, session_crons }
# Output: {"decision":"block","reason":"…"} or nothing. Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\x1f' read -r cwd active agent < <(jq -r '[(.cwd // ""), ((.stop_hook_active // false) | tostring), (.agent_id // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0
[[ -n "${agent:-}" ]] || exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
[[ -s "$CC_CLAIMS" ]] || exit 0

if ! cc_on subagent_release 1; then exit 0; fi
# auto mode: only act when sea-lite is actually configured (cheap: claims.json
# only ever gets entries from sea_* tool results, so this is belt and braces).
[[ -n "$(cc_cfg_raw subagent_release)" ]] || cc_sea_configured || exit 0

live="$(cc_claims_live "$agent")"
[[ "$live" != "[]" ]] || exit 0

cc_pending_add "$live" "subagent ${agent} stopped holding the claim"

[[ "${active:-false}" == "true" ]] && exit 0
key="$(jq -r 'map(.ticket_id) | sort | join(",")' <<<"$live" 2>/dev/null)"
latch="subagent_block_${agent//[^A-Za-z0-9_]/_}"
[[ "$(cc_state_get "$latch")" == "$key" ]] && exit 0
cc_state_set "$latch" "$key"

n="$(jq 'length' <<<"$live")"
cc_emit_block "release your sea-lite claim(s) before finishing — you still hold ${n}:
$(cc_claims_lines "$live")
Call sea_release (with a hand-off note) or sea_transition to a terminal state for each, then finish. (cc-anchor; fires once per claim set. The parent session will also see these as pending releases.)"
cc_log "SubagentStop: blocked once for agent $agent ($key)"
exit 0
