#!/usr/bin/env bash
# cc-anchor — status line segment.
#
#   ⚓ <goal-short> · <N> since compact · drift: <M>m
#
# "drift" is minutes since the card's hand-edited top was last refreshed
# (via /cc-anchor:anchor set|add-invariant|refresh, or a hand edit the
# PostToolUse hook noticed). Past CC_ANCHOR_DRIFT_WARN_MIN (default 45) the
# drift segment turns yellow with a ⚠; past 2x it turns red.
#
# Input (stdin, per statusline reference "Available data"):
#   { cwd, session_id, workspace:{current_dir, project_dir, …}, model:{…},
#     context_window:{…}, … }
# Output: one line. Runs locally, no tokens. Exit 0 always.
#
# This file is self-contained apart from lib.sh next to it; `anchor.mjs
# statusline install` copies both to ~/.claude/cc-anchor/ so the settings
# entry survives plugin updates (plugin cache paths change per version).
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || { printf '⚓ cc-anchor: jq missing\n'; exit 0; }

input="$(cat 2>/dev/null || true)"
root="$(jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // empty' <<<"$input" 2>/dev/null || true)"
cc_resolve "${root:-${CLAUDE_PROJECT_DIR:-$PWD}}"

if [[ ! -s "$CC_CARD" ]]; then
  printf '⚓ no anchor · /cc-anchor:anchor set goal "…"\n'
  exit 0
fi

goal="$(cc_card_goal)"
[[ -z "$goal" || "$goal" == "(unset"* ]] && goal="(no goal)"
max="${CC_ANCHOR_GOAL_WIDTH:-40}"
if (( ${#goal} > max )); then goal="${goal:0:$((max-1))}…"; fi

since="$(cc_count_since_compact)"
drift="$(cc_drift_minutes)"

color="${CC_ANCHOR_COLOR:-1}"
reset=$'\033[0m'; yellow=$'\033[33m'; red=$'\033[31m'; dim=$'\033[2m'
[[ "$color" == "1" ]] || { reset=""; yellow=""; red=""; dim=""; }

if [[ -z "$drift" ]]; then
  drift_seg="${dim}drift: never refreshed${reset}"
elif (( drift >= CC_DRIFT_WARN_MIN * 2 )); then
  drift_seg="${red}drift: ${drift}m ⚠${reset}"
elif (( drift >= CC_DRIFT_WARN_MIN )); then
  drift_seg="${yellow}drift: ${drift}m ⚠${reset}"
else
  drift_seg="drift: ${drift}m"
fi

printf '⚓ %s · %s since compact · %s\n' "$goal" "$since" "$drift_seg"
exit 0
