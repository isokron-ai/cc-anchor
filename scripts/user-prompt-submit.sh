#!/usr/bin/env bash
# cc-anchor — UserPromptSubmit hook (no matcher).
#
# Manual re-ground: when the operator types the bare word `anchor` (no
# slash), the current card is injected alongside the prompt. Every other
# prompt passes through untouched (empty stdout, exit 0) in ~5 ms.
#
# Input (stdin, per hooks reference "UserPromptSubmit input"):
#   { session_id, transcript_path, cwd, permission_mode,
#     hook_event_name:"UserPromptSubmit", prompt:"…" }
# Output (per "UserPromptSubmit decision control"):
#   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\t' read -r prompt cwd < <(jq -r '[(.prompt // "" | gsub("^\\s+|\\s+$"; "") | ascii_downcase), (.cwd // "")] | @tsv' <<<"$input" 2>/dev/null) || exit 0
[[ "${prompt:-}" == "anchor" ]] || exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_render
if [[ -s "$CC_CARD" ]]; then
  ctx="ANCHOR — re-ground requested by the operator (bare word \`anchor\`); verbatim card from disk
$(cat "$CC_CARD")

Treat the card as authoritative over earlier conversational state-claims; anything that conflicts is RETRACTED."
else
  ctx="ANCHOR — no card on disk yet (${CC_CARD}). Create one with /cc-anchor:anchor set goal \"…\"."
fi
cc_emit_context UserPromptSubmit "$ctx"
exit 0
