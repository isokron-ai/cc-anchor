#!/usr/bin/env bash
# cc-anchor — PreToolUse hook (matcher "Bash"): the kronicle-lite gate.
#
# 0.5.1 — stop parsing shell to FIND dangerous commands (hardening round 2:
# H2-01…H2-09); instead:
#
#   * Nothing pending (and the store reads ok): every Bash call runs. No
#     regex, no chain-split or one-liner denials (0.5.0's false alarms).
#   * Something pending — kronicle-lite >= 0.8.0 reports pending_count > 0
#     for ANY actor this agent reads as (the configured server actor plus
#     every actor_id it passed to an MCP tool), or, on kronicle-lite <=
#     0.7.0, a blocking retraction it has not seen (pushed on the last tool
#     result, or landed since its cursor), or the store reports an integrity
#     failure: every Bash call is DENIED unless scripts/readonly.jq can prove
#     it read-only (cat, less, head, tail, ls, grep, rg, find without -exec,
#     git status/log/diff/show…, kronicle-lite get/pending/orient, sea-lite
#     board/list/show, echo, pwd …; anything the parser does not fully
#     understand is not read-only). The reason names each change (document ›
#     heading, the version read → the current one, the diff) and says that
#     re-reading clears it.
#
# Re-reading the current version (recall, kronicle://docs/<slug>, or
# `kronicle-lite get <slug> --actor <actor>`, itself read-only) clears the
# pending gate with no manual step; receiving the push, retrying or naming
# another actor never does. On kronicle-lite <= 0.7.0 the deny is the
# delivery (the cursor moves past it) and a retry runs, as before.
# `pulse_mode: warn` allows the call and adds the same text as context.
#
# Fail closed while something is pending: an error or a timeout inside the
# gate (the classifier, a kronicle-lite read) then denies on the last known
# answer. Fail open while nothing is known to be pending: kronicle-lite not
# configured, its CLI missing, slow or broken => allow, one log line.
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

# 0.5.0 Bash claimed-path guard: mark when this call began (one builtin
# write; PostToolUse compares against it). Independent of kronicle-lite.
cc_bg_prestamp "$input"

sid=""
[[ "$input" =~ \"session_id\":[[:space:]]*\"([^\"]*)\" ]] && sid="${BASH_REMATCH[1]}"
cc_kl_session "$sid" "$(cc_payload_agent "$input")"
[[ -e "$CC_KL_S.off" ]] && exit 0
case "$(cc_cfg_raw pulse)" in 0|false|no|off) exit 0;; esac

# One jq: scripts/readonly.jq (a regex lexer + allowlist, capped at
# pulse_max_bytes) says whether the call is read-only, and whether it runs
# an operator-only kronicle-lite override (`shim ack`, `pending ack`, `shim
# uninstall` …). It runs here, before the kronicle-lite checks, only when the
# call mentions an override at all (bash regex); otherwise after them.
max="$(cc_cfg_raw pulse_max_bytes)"; [[ "$max" =~ ^[0-9]+$ ]] || max=8192
ro=""; why=""; head=""; ack=""; analysed=0
analyse() {
  analysed=1
  local line
  line="$(jq -r --arg max "$max" --arg fmt line -f "$CC_LIB_DIR/readonly.jq" <<<"$input" 2>/dev/null)" || line=""
  IFS=$'\x1f' read -r ro why head ack <<<"$line"
}

# H2-12: acknowledging a change (or switching the shims off) clears
# kronicle-lite's own exec-time gate WITHOUT a re-read. That is the
# operator's decision; an agent that runs it is denied, in any pulse_mode,
# whether or not kronicle-lite is configured for this project.
if [[ "$input" =~ (shim|pending)[^A-Za-z0-9]{1,12}(ack|uninstall|install|off) ]]; then
  analyse
  if [[ "$ack" == true ]]; then
    cc_log "pulse: denied \`${head:0:60}\` (kronicle-lite override is operator-only)"
    cc_emit_deny "cc-anchor pulse: did NOT run \`${head}\` — acknowledging a kronicle-lite change, or installing / uninstalling / reconfiguring the shims, overrides the gate WITHOUT re-reading what changed. That is the operator's decision, not the agent's. Re-read the pending items instead (\`kronicle-lite pending --actor <your actor>\` lists them; recall, kronicle://docs/<slug> or \`kronicle-lite get <slug> --actor <your actor>\` clears each one), or ask the operator to run this command themselves."
    exit 0
  fi
fi

cc_kl_enabled || exit 0

# Read-only calls always run: decided before any kronicle-lite work.
(( analysed )) || analyse
[[ "$ro" == true ]] && exit 0
if [[ "$ro" != false ]]; then
  why="the gate could not analyse it"; head="(this Bash call)"
  cc_log_once pulse_ro_err "pulse: the read-only classifier failed; treating the call as not read-only"
fi

mode="$(cc_cfg_raw pulse_mode)"; [[ "$mode" == warn ]] || mode="deny"
RO_LIST="cat, less, head, tail, ls, grep, rg, find (no -exec/-delete), wc, diff, jq, git status/log/diff/show/branch --list/rev-parse/ls-files, kronicle-lite get/pending/orient, sea-lite board/list/show, echo, printf, pwd, which, cd"

# gate <log-what> <what is pending> <deny-only tail> [warn connector: but|while]
gate() {
  : > "$CC_KL_B.wcattempt" 2>/dev/null || true
  if [[ "$mode" == warn ]]; then
    cc_log "pulse: warned before \`${head:0:60}\` ($1)"
    cc_emit_context PreToolUse "cc-anchor pulse (warn): \`${head}\` is about to run ${4:-but} $2
Check that this command uses the current values; if not, stop and re-run it with them."
  else
    cc_log "pulse: denied \`${head:0:60}\` ($1)"
    cc_emit_deny "cc-anchor pulse: did NOT run \`${head}\` — $2
$3"
  fi
  exit 0
}

# H2-11: the store may have changed and kronicle-lite could not be read now.
gate_unknown() {
  gate "kronicle-lite unreadable, store changed since the last answer" "kronicle-lite could not be read just now (failed or timed out; see .claude/cc-anchor/log), and the store has changed since its last answer, so cc-anchor cannot tell whether something you relied on changed." "Until it can be read again, only read-only Bash commands run (${RO_LIST}); this call is not one: ${why}. Retry in a moment. If kronicle-lite stays unreadable, tell the operator (they can repair it, or set pulse_mode: warn)."
}

legacy=""
[[ -s "$CC_KL_B.pending" ]] && legacy="$(cat "$CC_KL_B.pending" 2>/dev/null)"
had_integ=0; [[ -s "$CC_KL_S.integrity" ]] && had_integ=1
CC_KL_FAILED=0; CC_KL_XFAIL=0
cc_kl_fetch strict || true
# H2-11: a read was needed (the store may have changed since the last answer)
# and failed, and this agent HAS had answers before: the cached answer is
# stale, not "nothing pending". (No answer ever — a CLI broken since the
# session started — stays fail-open, as before.)
unknown=0
if (( CC_KL_FAILED == 1 )) && [[ -s "$CC_KL_B.cursor" ]]; then unknown=1; fi

# A store that reports integrity.ok=false: only read-only calls run until a
# fresh read says it is ok again (an older failure is re-checked now; at
# most three bounded CLI calls in all, inside the hook's 15 s).
if [[ -s "$CC_KL_S.integrity" ]]; then
  if (( had_integ == 0 )) || cc_kl_integrity_recheck; then
    itext="$(cc_kl_integrity_text)"
    gate "store integrity failure" "${itext#cc-anchor: }" "Until a fresh read reports the store ok, only read-only Bash commands run (${RO_LIST}); this call is not one: ${why}." while
  fi
fi

# kronicle-lite >= 0.8.0: `pending` per actor — every change to what the
# agent read (as any of its actors) that it has not re-read at the current
# version. Cleared only by re-reading. Older kronicle-lite: the
# retraction-since-last-look logic below.
if [[ -e "$CC_KL_S.klcap" ]] || [[ ! -e "$CC_KL_S.klnocap" && "$CC_KL_FAILED" != 1 ]]; then
  if [[ ! -s "$CC_KL_B.klpend" ]] && ! cc_kl_pending_refresh && [[ -s "$CC_KL_B.cursor" ]]; then unknown=1; fi
fi
if [[ -e "$CC_KL_S.klcap" ]]; then
  rm -f "$CC_KL_B.pending" 2>/dev/null; legacy=""; KL_BLOCK=0
  cc_kl_extra_pending
  (( CC_KL_XFAIL > 0 )) && unknown=1
  total=0; items=""; acts=""; known=""
  for f in "$CC_KL_B.klpend" "$CC_KL_B".xp-*; do
    [[ -s "$f" ]] || continue
    phead=""; IFS= read -r phead < "$f"
    pc="" phid="" pact=""
    IFS=$'\x1f' read -r pc phid pact _ <<<"$phead"
    known="${known:+$known, }${pact}"
    if [[ ! "$pc" =~ ^[0-9]+$ ]] || (( pc == 0 )); then continue; fi
    total=$((total + pc))
    acts="${acts:+$acts, }${pact}"
    it="$(tail -n +2 "$f" 2>/dev/null)"
    [[ "$phid" =~ ^[1-9][0-9]*$ ]] && it="${it}
- (+${phid} pending about other projects' documents, not listed)"
    items="${items:+$items
}${it}"
  done
  if (( total > 0 )); then
    if [[ "$acts" == *", "* ]]; then who="you relied on (as actors ${acts})"; else who="you (actor ${acts}) relied on"; fi
    gate "${total} pending for ${acts}" "${total} kronicle-lite change(s) ${who} are not re-read at their current version:
${items}" "Until you re-read them, only read-only Bash commands run (${RO_LIST}); this call is not one: ${why}.
Re-read each (recall, or kronicle://docs/<slug>): that clears this check by itself — receiving or acknowledging a change, retrying, or reading as another actor does not. Then check the values this command uses and run it again."
  fi
  (( unknown )) && gate_unknown
  if (( KL_SHOWN > 0 )); then
    cc_emit_context PreToolUse "cc-anchor pulse: kronicle-lite changed since your last check (head seq ${KL_SEQ}). None of it is pending re-read for you (actor(s) ${known:-$CC_KL_ACTOR}), so \`${head}\` runs; for reference:
${KL_BODY}"
  fi
  exit 0
fi

block_lines="$legacy"
if (( KL_BLOCK > 0 )); then block_lines="${block_lines:+$block_lines
}$KL_BODY"; fi
if [[ -n "$block_lines" ]]; then
  rm -f "$CC_KL_B.pending" 2>/dev/null
  n="$(grep -c '^- ' <<<"$block_lines" 2>/dev/null || echo 1)"
  gate "${n} unreconciled retraction(s)" "kronicle-lite has ${n} change(s) you have not reconciled${KL_SEQ:+ (head seq ${KL_SEQ})}:
${block_lines}" "This call is not read-only (${why}), so it was held back. Re-read the affected document(s) (recall, or get_system_state with your cursor), check the values this command uses, then run it again."
fi

(( unknown )) && gate_unknown
if (( KL_SHOWN > 0 )); then
  cc_emit_context PreToolUse "cc-anchor pulse: kronicle-lite changed since your last check (head seq ${KL_SEQ}); none of it is a blocking retraction, so \`${head}\` runs:
${KL_BODY}"
fi
exit 0
