#!/usr/bin/env bash
# cc-anchor — UserPromptSubmit hook (no matcher).
#
# Manual re-ground: when the operator types the bare word `anchor` (no
# slash), the current card is injected alongside the prompt. Every other
# prompt passes through untouched (empty stdout, exit 0) in ~5 ms — except
# when state.reassert_pending=1 (set by the InstructionsLoaded(compact) hook
# when the SessionStart(compact) injection did not happen): then the card is
# injected once with this prompt and the flag cleared.
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
IFS=$'\x1f' read -r prompt cwd < <(jq -r '[(.prompt // "" | gsub("\\s+"; " ") | gsub("^ | $"; "") | ascii_downcase), (.cwd // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
mode=""
if [[ "${prompt:-}" == "anchor" ]]; then mode=manual
elif [[ -s "$CC_STATE" ]]; then
  # bash pattern match, no jq, keeps the pass-through path at ~5 ms
  st="$(<"$CC_STATE")"
  [[ "$st" =~ \"reassert_pending\":[[:space:]]*\"?1\"? ]] && mode=reassert
fi
[[ -n "$mode" ]] || exit 0

cc_render
if [[ "$mode" == "reassert" ]]; then
  cc_state_set reassert_pending 0
  header="ANCHOR — verbatim, read before anything else (re-asserted: the post-compaction injection did not run for the last compaction)"
else
  header="ANCHOR — re-ground requested by the operator (bare word \`anchor\`); verbatim card from disk"
fi
if [[ -s "$CC_CARD" ]]; then
  ctx="${header}
$(cat "$CC_CARD")

Treat the card as authoritative over earlier conversational state-claims; anything that conflicts is RETRACTED."
else
  ctx="ANCHOR — no card on disk yet (${CC_CARD}). Create one with /cc-anchor:anchor set goal \"…\"."
fi
pending="$(cc_pending_live)"
if [[ -n "$pending" && "$pending" != "[]" ]]; then
  ctx="${ctx}

Pending sea-lite releases (still live; release before taking new work):
$(cc_claims_lines "$pending")"
fi
cc_emit_context UserPromptSubmit "$ctx"
exit 0
