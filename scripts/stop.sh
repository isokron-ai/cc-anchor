#!/usr/bin/env bash
# cc-anchor — Stop hook (no matcher).
#
# Four jobs, in this order (the first decision wins; later ones only add):
#
#   1. Trail rotation (always).
#   2. sea-lite claim guard (config `claim_guard`, opt-in): when claims.json
#      shows a live claim taken in this session and Claude is about to stop,
#      emit {"decision":"block","reason":"release or hand off your sea-lite
#      claim first …"} naming every ticket + token so the model can call
#      sea_release / sea_transition. ONCE per claim set: the key
#      (session + sorted ticket ids) is latched in state.json, and
#      stop_hook_active=true (Claude Code already continuing because of a
#      stop hook) always short-circuits, so the 8-continuation cap is never
#      approached.
#   3. kronicle-lite session document (config `session_doc`, opt-in): write
#      `session-<YYYY-MM-DD>-<sid8>` = anchor card + last_assistant_message
#      through `kronicle-lite put` (the CLI opens the same store the MCP
#      server does). Skipped when the message is empty or unchanged since
#      the last put (hash in state.json). Runs in the background AFTER the
#      decision is printed, output redirected, per the hooks reference
#      ("Hooks that start a background process"); CC_ANCHOR_SYNC=1 runs it
#      inline (tests).
#   4. Drift nudge (unchanged from 0.1.0): once per 30 min a one-line
#      systemMessage when the goal is > CC_ANCHOR_DRIFT_WARN_MIN old.
#      CC_ANCHOR_STOP_WARN=0 disables.
#
# Input (stdin, per hooks reference "Stop input"):
#   { session_id, transcript_path, cwd, permission_mode, hook_event_name:"Stop",
#     stop_hook_active, last_assistant_message, background_tasks, session_crons }
# Output: one JSON object or nothing. Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\x1f' read -r cwd active sid < <(jq -r '[(.cwd // ""), ((.stop_hook_active // false) | tostring), (.session_id // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0
active="${active:-false}"

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_trail_rotate

decision=""   # JSON object to print, if any

# ── 2. claim guard ────────────────────────────────────────────────────
if [[ "$active" != "true" ]] && cc_on claim_guard 0 && [[ -s "$CC_CLAIMS" ]]; then
  live="$(cc_claims_live '*' "$sid")"
  if [[ "$live" != "[]" ]]; then
    key="${sid}:$(jq -r 'map(.ticket_id) | sort | join(",")' <<<"$live" 2>/dev/null)"
    if [[ "$(cc_state_get claim_block_key)" != "$key" ]]; then
      cc_state_set claim_block_key "$key" claim_block_at "$(cc_now)"
      n="$(jq 'length' <<<"$live")"
      reason="release or hand off your sea-lite claim first: ${n} live claim(s) in this session. Either finish the ticket (sea_transition to resolved / another terminal state, which releases the claim) or give it back with a hand-off note:
$(cc_claims_lines "$live")
(cc-anchor claim guard; this reminder fires once per claim set. Disable with CC_ANCHOR_CLAIM_GUARD=0.)"
      decision="$(cc_emit_block "$reason")"
      cc_log "Stop: blocked once for live claims ($key)"
    fi
  fi
fi

# ── 3. session document (kronicle-lite) ───────────────────────────────
session_doc_slug=""; session_doc_file=""; session_doc_title=""
if cc_on session_doc 0 && [[ -s "$CC_CARD" ]]; then
  msg="$(jq -r '.last_assistant_message // ""' <<<"$input" 2>/dev/null || true)"
  if [[ -n "$msg" ]]; then
    h="$(cc_hash "$msg")"
    if [[ "$(cc_state_get session_doc_hash)" != "$h" ]]; then
      if cc_find_cli kronicle-lite >/dev/null; then
        today="$(cc_now)"; today="${today%%T*}"
        sid8="$(cc_sid_short "$sid")"
        slug="session-${today}-${sid8}"
        doc="$CC_RUN/session-doc.md"
        {
          printf '# Session %s — %s\n\n' "$sid8" "$today"
          printf 'Project: %s  \nWritten by cc-anchor on Stop (last turn only; earlier turns are previous revisions of this slug).\n\n' "$CC_ROOT"
          printf '## Anchor card (verbatim)\n\n```\n'
          cat "$CC_CARD"
          printf '```\n\n## Last assistant message\n\n%s\n' "$msg"
        } > "$doc" 2>/dev/null && {
          cc_state_set session_doc_hash "$h" session_doc_slug "$slug"
          session_doc_slug="$slug"; session_doc_file="$doc"; session_doc_title="Session $today $sid8"
        }
      else
        cc_log_once session_doc_nobin "session_doc: kronicle-lite CLI not found (PATH, plugin cache, CC_ANCHOR_KRONICLE_LITE_BIN); skipping"
      fi
    fi
  fi
fi

put_session_doc() {
  local -a dd=()
  [[ -n "${CC_ANCHOR_KRONICLE_DATA_DIR:-}" ]] && dd=(--data-dir "$CC_ANCHOR_KRONICLE_DATA_DIR")
  if cc_run_cli kronicle-lite put "$session_doc_slug" "$session_doc_file" --title "$session_doc_title" --actor cc-anchor ${dd[@]+"${dd[@]}"} >> "$CC_LOG" 2>&1; then
    cc_log "session_doc: put $session_doc_slug"
  else
    cc_log "session_doc: put $session_doc_slug FAILED (see above)"
  fi
}

# ── 4. drift nudge ────────────────────────────────────────────────────
if [[ -z "$decision" && "$active" != "true" && "${CC_ANCHOR_STOP_WARN:-1}" == "1" && -s "$CC_CARD" ]]; then
  drift="$(cc_drift_minutes)"
  if [[ -n "$drift" && "$drift" -ge "$CC_DRIFT_WARN_MIN" ]]; then
    warned="$(cc_state_get warned_at)"; ok=1
    if [[ -n "$warned" ]]; then w="$(cc_epoch "$warned")"; w="${w:-0}"; (( $(date -u +%s) - w < 1800 )) && ok=0; fi
    if [[ "$ok" == "1" ]]; then
      cc_state_set warned_at "$(cc_now)"
      decision="$(jq -nc --arg m "⚓ cc-anchor: the goal on the anchor card is ${drift} min old. Refresh it with /cc-anchor:anchor set goal \"…\" (or /cc-anchor:anchor refresh) so the next compaction carries the current goal." '{systemMessage:$m}')"
    fi
  fi
fi

# Print the decision FIRST, then start any background work with its output
# redirected (otherwise Claude Code refuses "the suspect capture").
[[ -n "$decision" ]] && printf '%s\n' "$decision"
if [[ -n "$session_doc_slug" ]]; then
  if [[ "${CC_ANCHOR_SYNC:-0}" == "1" ]]; then put_session_doc
  else (put_session_doc) >/dev/null 2>&1 & fi
fi
exit 0
