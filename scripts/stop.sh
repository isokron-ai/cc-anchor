#!/usr/bin/env bash
# cc-anchor — Stop hook (no matcher).
#
# Drift nudge for operators without a statusline: when the card's goal is
# older than CC_ANCHOR_DRIFT_WARN_MIN minutes (default 45) and we have not
# nudged in the last 30 minutes, show a one-line systemMessage. Never
# blocks (no `decision`), never continues the turn. Opt out with
# CC_ANCHOR_STOP_WARN=0.
#
# Input (stdin, per hooks reference "Stop input"):
#   { session_id, transcript_path, cwd, permission_mode, hook_event_name:"Stop",
#     stop_hook_active, last_assistant_message, background_tasks, session_crons }
# Output: {"systemMessage":"…"} or nothing. Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0
[[ "${CC_ANCHOR_STOP_WARN:-1}" == "1" ]] || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\t' read -r cwd active < <(jq -r '[(.cwd // ""), ((.stop_hook_active // false) | tostring)] | @tsv' <<<"$input" 2>/dev/null) || exit 0
[[ "${active:-false}" == "true" ]] && exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_trail_rotate
[[ -s "$CC_CARD" ]] || exit 0

drift="$(cc_drift_minutes)"
[[ -n "$drift" && "$drift" -ge "$CC_DRIFT_WARN_MIN" ]] || exit 0

warned="$(cc_state_get warned_at)"
if [[ -n "$warned" ]]; then
  w="$(cc_epoch "$warned")"; w="${w:-0}"
  (( $(date -u +%s) - w < 1800 )) && exit 0
fi
cc_state_set warned_at "$(cc_now)"
jq -nc --arg m "⚓ cc-anchor: the goal on the anchor card is ${drift} min old. Refresh it with /cc-anchor:anchor set goal \"…\" (or /cc-anchor:anchor refresh) so the next compaction carries the current goal." '{systemMessage:$m}'
exit 0
