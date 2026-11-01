#!/usr/bin/env bash
# cc-anchor — PreToolUse hook (matcher "Bash"): the kronicle-lite pulse.
#
# Before a world-changing Bash command (config `pulse_match`, default
# deploy|migrate|publish|release|git push|terraform apply|kubectl apply),
# check kronicle-lite for retractions this session has not reconciled:
#
#   * pending — blocking retractions the PostToolUse push delivered on the
#     very last tool result, with no tool call since (the agent decided on
#     this command before it could act on them);
#   * new — retractions that landed since this session's cursor (a change
#     the push could not deliver yet: it arrived after the last tool call).
#
# A blocking one (semantic, severity safety|behavioral; cosmetic only when
# kronicle-lite says so) DENIES the command with the diff in the reason: the
# agent re-reads and runs it again. `pulse_mode: warn` allows the command and
# adds the same text as context instead. Non-blocking news is added as
# context and the command runs.
#
# Chains (F2): in `a && b && deploy` a change that lands while `b` runs is
# invisible to any check made before the call, and the PostToolUse push only
# arrives after the stale deploy. With `pulse_chain: split` (default) a call
# that runs a world-changing step AFTER another non-inert step is denied once
# with "run it as its own Bash call"; cd / export / echo / read-only steps
# (grep, cat, ls, git status …) do not count. `pulse_chain: check` only
# checks before the whole call.
#
# Inert (exit 0, no output) unless kronicle-lite is configured and its CLI is
# found (same detection as the push; switch `pulse`, auto = on with the push).
# Fail-open: CLI missing / slow / broken => allow, one log line.
#
# Input: { session_id, cwd, tool_name:"Bash", tool_input:{command}, … }
# Output: {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#           "permissionDecision":"deny","permissionDecisionReason":"…"}}
#   or {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}
#   or nothing. Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input=""
IFS= read -r -d '' input || true
[[ -n "$input" ]] || exit 0
[[ "$input" =~ \"tool_name\":[[:space:]]*\"Bash\" ]] || exit 0

root="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$root" && "$input" =~ \"cwd\":[[:space:]]*\"([^\"]*)\" ]]; then root="${BASH_REMATCH[1]}"; fi
cc_resolve "${root:-$PWD}"

sid=""
[[ "$input" =~ \"session_id\":[[:space:]]*\"([^\"]*)\" ]] && sid="${BASH_REMATCH[1]}"
cc_kl_session "$sid"
[[ -e "$CC_KL_B.off" ]] && exit 0
case "$(cc_cfg_raw pulse)" in 0|false|no|off) exit 0;; esac
cc_kl_enabled || exit 0

match="$(cc_cfg_raw pulse_match)"
[[ -n "$match" ]] || match='deploy|migrate|publish|release|git push|terraform apply|kubectl apply'
an="$(jq -c --arg match "$match" -f "$CC_LIB_DIR/pulse.jq" <<<"$input" 2>/dev/null)" || { cc_log_once pulse_badre "pulse: could not analyse the command (bad pulse_match regex?); allowing"; exit 0; }
[[ "$an" == *'"world":[]'* ]] && exit 0

head="$(jq -r '.head' <<<"$an" 2>/dev/null)"
mode="$(cc_cfg_raw pulse_mode)"; [[ "$mode" == warn ]] || mode="deny"
chain="$(cc_cfg_raw pulse_chain)"; [[ "$chain" == check ]] || chain="split"

pending=""
[[ -s "$CC_KL_B.pending" ]] && pending="$(cat "$CC_KL_B.pending" 2>/dev/null)"
CC_KL_FAILED=0
cc_kl_fetch || true

block_lines="$pending"
if (( KL_BLOCK > 0 )); then block_lines="${block_lines:+$block_lines
}$KL_BODY"; fi

if [[ -n "$block_lines" ]]; then
  rm -f "$CC_KL_B.pending" 2>/dev/null
  n="$(grep -c '^- ' <<<"$block_lines" 2>/dev/null || echo 1)"
  if [[ "$mode" == warn ]]; then
    cc_log "pulse: warned before \`${head:0:60}\` (${n} unreconciled retraction(s))"
    cc_emit_context PreToolUse "cc-anchor pulse (warn): \`${head}\` is about to run, but kronicle-lite has ${n} change(s) you have not reconciled:
${block_lines}
Check that this command uses the current values; if not, stop and re-run it with them."
  else
    cc_log "pulse: denied \`${head:0:60}\` (${n} unreconciled retraction(s))"
    cc_emit_deny "cc-anchor pulse: did NOT run \`${head}\` — kronicle-lite has ${n} change(s) you have not reconciled${KL_SEQ:+ (head seq ${KL_SEQ})}:
${block_lines}
Re-read the affected document(s) (recall, or get_system_state with your cursor), check the values this command uses, then run it again$( [[ "$chain" == split && "$an" != *'"risky":[]'* ]] && printf ' as its own Bash call' )."
  fi
  exit 0
fi

# The store could not be read: fail open (no chain split either).
(( CC_KL_FAILED == 1 )) && exit 0

if [[ "$chain" == split && "$an" != *'"risky":[]'* ]]; then
  IFS=$'\x1f' read -r nrisky risky < <(jq -r '[(.risky | length | tostring), (.risky | map("`" + .[0:80] + "`") | join(", "))] | join("\u001f")' <<<"$an" 2>/dev/null)
  cc_log "pulse: split chain before ${risky:0:80}"
  if [[ "$nrisky" == 1 ]]; then each="${risky}"; else each="each of ${risky}"; fi
  cc_emit_deny "cc-anchor pulse: did NOT run this Bash call — it runs ${risky} after other steps in the same call, so a change that lands while those steps run (for example a runbook update during a build) cannot be checked before it. Run the earlier steps first, then ${each} as its own Bash call. (Config pulse_chain: check allows such chains.)"
  exit 0
fi

if (( KL_SHOWN > 0 )); then
  cc_emit_context PreToolUse "cc-anchor pulse: kronicle-lite changed since your last check (head seq ${KL_SEQ}); none of it blocks \`${head}\`:
${KL_BODY}"
fi
exit 0
