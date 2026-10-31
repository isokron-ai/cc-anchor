#!/usr/bin/env bash
# cc-anchor — PreCompact hook (matcher "manual|auto").
#
# SAVE side of the compaction bracket: render the card verbatim to disk and
# stamp compacted_at so the SessionStart(compact) hook can re-inject it at
# primacy position and the statusline can count "breadcrumbs since compact".
#
# Input (stdin, per hooks reference "PreCompact input"):
#   { session_id, transcript_path, cwd, hook_event_name:"PreCompact",
#     trigger:"manual"|"auto", custom_instructions:string|null }
# Output: NOTHING. The reference documents only `decision:"block"` +
#   `reason` for PreCompact and says `systemMessage`/`continue` are
#   discarded; there is no additionalContext channel into the compaction
#   prompt. We never block. Exit 0 always (fail-open).
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null || true)"
trigger="$(jq -r '.trigger // "auto"' <<<"$input" 2>/dev/null || echo auto)"

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
count="$(cc_state_get compact_count)"; count="${count:-0}"
[[ "$count" =~ ^[0-9]+$ ]] || count=0
cc_state_set compacted_at "$(cc_now)" compact_trigger "$trigger" compact_count "$(( count + 1 ))"
cc_trail_rotate
cc_render
exit 0
