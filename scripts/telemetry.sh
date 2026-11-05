#!/usr/bin/env bash
# cc-anchor — audit telemetry (opt-in; benchmark accounting).
#
# Hook (Stop, SubagentStop, PreCompact, SessionEnd): reads the transcript
# lines written since its last run and appends cca.telemetry/1 records
# (scripts/telemetry.jq) to the telemetry file. Nothing runs per tool call:
# tool sizes and latencies come from the transcript too.
#
# On when CC_ANCHOR_OBSERVER is `telemetry` or `telemetry+anchors`, or
# CC_ANCHOR_TELEMETRY=1 (but never under CC_ANCHOR_OBSERVER=off).
#   CC_ANCHOR_OBSERVER       off | telemetry | telemetry+anchors (observer-
#                            effect arms; `off` and `telemetry` also make
#                            every other cc-anchor hook a no-op, see lib.sh)
#   CC_ANCHOR_TELEMETRY_FILE JSONL path (default <run dir>/telemetry.jsonl)
#   CC_ANCHOR_TELEMETRY_FORMAT  cca (default) | kronicle (draft kronicle-lite
#                            audit events: call_measured, turn_usage, …)
#   CC_ANCHOR_TELEMETRY_OVERHEAD=1  a telemetry_overhead record on every run
#                            (default: only on runs that flushed records)
#   CC_ANCHOR_TELEMETRY_WINDOW (4194304) bytes read per jq pass;
#   CC_ANCHOR_TELEMETRY_BUDGET (5) seconds of work per hook run — the hook
#                            timeout is 10 s; the rest is read next time.
#
# Bounded and exactly once (state in <run dir>/telemetry.state/, 0700):
#   * per transcript: "<offset> <head length> <head cksum>" — the offset
#     only moves after the window's records are appended, and is replaced
#     atomically (temp, sync, rename). A file shorter than the offset or
#     with another head was truncated / rewritten: read again from 0;
#   * <key>.seen — the last 20000 keys counted (message ids, tool_use ids,
#     compactions): a response straddling two windows or a re-read file is
#     never counted twice;
#   * <key>.open — tool uses still waiting for their result;
#   * a window is staged (≤ WINDOW bytes, mode 0600) in a private
#     tmp.<pid> directory, removed on exit; a directory left by a killed run
#     is removed by the next run. The transcript itself is never copied.
#   * a line longer than the window (an image, a huge tool result) is
#     skipped and reported as `oversize_line` (its bytes only).
#   * one run at a time (lock with the owner's pid; a dead owner's lock is
#     taken over, a live one never is: the run is skipped).
#
# Offline (no hook, no observer effect — e.g. the `off` arm):
#   bash scripts/telemetry.sh --scan <transcript.jsonl> [--subagents] [--kronicle]
# prints the records for the whole transcript (and its subagents/*.jsonl).
#
# Fail-open: exit 0, no stdout.
set -u

if [[ "${1:-}" == "--scan" ]]; then
  CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
  shift; tx="${1:-}"; shift || true; subs=0; fmt=cca
  for a in "$@"; do case "$a" in --subagents) subs=1;; --kronicle) fmt=kronicle;; esac; done
  [[ -s "$tx" ]] || { echo "usage: telemetry.sh --scan <transcript.jsonl> [--subagents] [--kronicle]" >&2; exit 2; }
  files=("$tx")
  if (( subs )); then for f in "${tx%.jsonl}"/subagents/*.jsonl; do [[ -s "$f" ]] && files+=("$f"); done; fi
  for f in "${files[@]}"; do
    b="${f##*/}"; ag=""; [[ "$b" == agent-*.jsonl ]] && { ag="${b#agent-}"; ag="${ag%.jsonl}"; }
    jq -nrc -R --arg sid "${tx##*/}" --arg agent "$ag" --arg observer "" --arg tx "$b" --arg ev scan --arg fmt "$fmt" --arg internal 0 \
      -f "$CC_HERE/telemetry.jq" < "$f" || exit 1
  done
  exit 0
fi

case "${CC_ANCHOR_OBSERVER:-}" in
  telemetry|telemetry+anchors) ;;
  off) exit 0;;
  *) case "${CC_ANCHOR_TELEMETRY:-}" in 1|true|yes|on) ;; *) exit 0;; esac;;
esac

t0="${EPOCHREALTIME:-}"
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\x1f' read -r cwd sid ev tx atx agent < <(jq -r '[(.cwd // ""), (.session_id // ""), (.hook_event_name // ""), (.transcript_path // ""), (.agent_transcript_path // ""), (.agent_id // "")] | map(tostring | gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_ensure_dirs || exit 0
out="${CC_ANCHOR_TELEMETRY_FILE:-$CC_RUN/telemetry.jsonl}"
fmt="${CC_ANCHOR_TELEMETRY_FORMAT:-cca}"
obs="${CC_ANCHOR_OBSERVER:-telemetry+anchors}"
win="${CC_ANCHOR_TELEMETRY_WINDOW:-4194304}"; [[ "$win" =~ ^[1-9][0-9]*$ ]] || win=4194304
budget="${CC_ANCHOR_TELEMETRY_BUDGET:-5}"; [[ "$budget" =~ ^[1-9][0-9]?$ ]] || budget=5
SEEN_KEEP=20000

umask 077
st="$CC_RUN/telemetry.state"
mkdir -p "$st" 2>/dev/null || exit 0
mkdir -p "${out%/*}" 2>/dev/null || true

# Hand-built records: only [A-Za-z0-9._+-] reaches them (no quoting needed).
sid_j="${sid//[^A-Za-z0-9._-]/}"; obs_j="${obs//[^A-Za-z0-9._+-]/}"; ev_j="${ev//[^A-Za-z]/}"
now=""; cc_now_var now

# ── one run at a time; private scratch; cleanup ──────────────────────────
# A killed run's pid can linger as a zombie until it is reaped: not alive.
alive() { [[ "$1" =~ ^[0-9]+$ ]] && kill -0 "$1" 2>/dev/null && [[ "$(ps -o stat= -p "$1" 2>/dev/null)" != *Z* ]]; }
for d in "$st"/tmp.*; do [[ -d "$d" ]] && ! alive "${d##*.}" && rm -rf "$d"; done
lock="$st/lock"; locked=0; tmpd="$st/tmp.$$"
# shellcheck disable=SC2329  # called by the EXIT trap
cleanup() { rm -rf "$tmpd" 2>/dev/null; if (( locked )); then rm -f "$lock/pid" 2>/dev/null; rmdir "$lock" 2>/dev/null; fi; }
trap cleanup EXIT
trap 'exit 1' TERM INT HUP
i=0
while ! mkdir "$lock" 2>/dev/null; do
  owner=""; [[ -s "$lock/pid" ]] && IFS= read -r owner < "$lock/pid"
  if [[ -n "$owner" ]] && ! alive "$owner"; then rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null; continue; fi
  i=$((i + 1)); (( i > 100 )) && { cc_log "telemetry: another run holds the lock; skipped (resumes next time)"; exit 0; }
  sleep 0.02 2>/dev/null || sleep 1
done
locked=1; printf '%s\n' "$$" > "$lock/pid"
mkdir "$tmpd" 2>/dev/null || exit 0

# Which transcripts this event flushes.
files=()
case "$ev" in
  SubagentStop) [[ -n "$atx" ]] && files+=("$atx|$agent");;
  SessionEnd)   [[ -n "$tx" ]] && files+=("$tx|")
                for f in "${tx%.jsonl}"/subagents/agent-*.jsonl; do
                  [[ -s "$f" ]] || continue; aid="${f##*/agent-}"; files+=("$f|${aid%.jsonl}"); done;;
  *)            [[ -n "$tx" ]] && files+=("$tx|");;
esac

start=$SECONDS; flushed=0
left() { (( SECONDS - start < budget )); }
headsum() { head -c "$2" "$1" 2>/dev/null | cksum | cut -d' ' -f1; }
fsize() { local s; s="$(wc -c < "$1" 2>/dev/null)"; printf '%s' "${s//[^0-9]/}"; }
save() {  # <state file> <offset> <head len> <head sum>
  printf '%s %s %s\n' "$2" "$3" "$4" > "$1.tmp.$$" || return 1
  [[ "$OSTYPE" == linux* ]] && sync -- "$1.tmp.$$" 2>/dev/null
  mv -f "$1.tmp.$$" "$1"
}

for spec in ${files[@]+"${files[@]}"}; do  # bash 3.2 + set -u: an empty array is unbound
  f="${spec%|*}"; ag="${spec##*|}"
  [[ -s "$f" ]] || continue
  key="${f##*/}"; key="${key//[^A-Za-z0-9._-]/_}"; sf="$st/$key"
  [[ -e "$sf.seen" ]] || : > "$sf.seen"; [[ -e "$sf.open" ]] || : > "$sf.open"
  off=0 hl=0 hs=""; [[ -s "$sf" ]] && read -r off hl hs < "$sf"
  [[ "$off" =~ ^[0-9]+$ ]] || off=0; [[ "$hl" =~ ^[0-9]+$ ]] || hl=0
  size="$(fsize "$f")"; [[ -n "$size" ]] || continue
  if (( size < off )) || { (( hl > 0 )) && [[ "$(headsum "$f" "$hl")" != "$hs" ]]; }; then
    cc_log "telemetry: ${key} was truncated or rewritten; re-reading it (already counted keys are skipped)"
    off=0; hl=0; hs=""
  fi
  while (( off < size )) && left; do
    c="$tmpd/chunk"
    tail -c +"$((off + 1))" "$f" 2>/dev/null | head -c "$win" > "$c" 2>/dev/null || break
    len="$(fsize "$c")"; [[ -n "$len" && "$len" -gt 0 ]] || break
    if [[ "$(tail -c 1 "$c" | od -An -c)" == *'\n'* ]]; then take=$len
    else part="$(tail -n 1 "$c" | wc -c)"; take=$(( len - ${part//[^0-9]/} )); fi
    nhl=$hl; (( nhl < 4096 )) && nhl=$(( off + take < 4096 ? off + take : 4096 ))
    if (( take == 0 )); then
      # No newline in a whole window: the line is still being written (end
      # of file) or longer than the window — skip it, counting its bytes.
      (( off + len >= size )) && break
      q=$(( off + len )); nl_hit=0
      while (( q < size )) && left; do
        tail -c +"$((q + 1))" "$f" 2>/dev/null | head -c "$win" > "$c" 2>/dev/null || break
        nls="$(tr -dc '\n' < "$c" | wc -c)"
        if (( ${nls//[^0-9]/} > 0 )); then q=$(( q + $(head -n 1 "$c" | wc -c) )); nl_hit=1; break; fi
        q=$(( q + $(fsize "$c") ))
      done
      (( nl_hit )) || break
      printf '{"schema":"cca.telemetry/1","session_id":"%s","observer":"%s","ev":"oversize_line","at":"%s","transcript":"%s","bytes":%d}\n' \
        "$sid_j" "$obs_j" "$now" "$key" "$(( q - off ))" >> "$out" 2>/dev/null || break
      nhl=$(( q < 4096 ? q : 4096 ))
      save "$sf" "$q" "$nhl" "$(headsum "$f" "$nhl")" || break
      off=$q; flushed=1; continue
    fi
    head -c "$take" "$c" > "$c.w" 2>/dev/null || break
    jq -nrc -R --arg sid "$sid" --arg agent "$ag" --arg observer "$obs" --arg tx "${f##*/}" --arg ev "$ev" --arg now "$now" --arg fmt "$fmt" \
      --arg internal 1 --rawfile seen "$sf.seen" --rawfile open "$sf.open" -f "$CC_LIB_DIR/telemetry.jq" < "$c.w" > "$tmpd/out" 2>/dev/null || break
    grep -v '^#' "$tmpd/out" > "$tmpd/recs"
    { cat "$sf.seen"; sed -n 's/^#seen	//p' "$tmpd/out"; } | tail -n "$SEEN_KEEP" > "$tmpd/seen"
    sed -n 's/^#open	//p' "$tmpd/out" > "$tmpd/open"
    # records first, then the state that says they were written
    if [[ -s "$tmpd/recs" ]]; then cat "$tmpd/recs" >> "$out" 2>/dev/null || break; flushed=1; fi
    mv -f "$tmpd/seen" "$sf.seen"; mv -f "$tmpd/open" "$sf.open"
    save "$sf" "$(( off + take ))" "$nhl" "$(headsum "$f" "$nhl")" || break
    off=$(( off + take )); hl=$nhl
  done
done

if [[ "$ev" == "PreCompact" ]]; then
  trig=""; [[ "$input" =~ \"trigger\":[[:space:]]*\"([a-z]+)\" ]] && trig="${BASH_REMATCH[1]}"
  printf '{"schema":"cca.telemetry/1","session_id":"%s","agent_id":null,"observer":"%s","ev":"compact_start","at":"%s","trigger":"%s"}\n' \
    "$sid_j" "$obs_j" "$now" "$trig" >> "$out" 2>/dev/null
fi

# This hook's own cost, from just after bash started to here (bash startup,
# a few ms, is not included): on runs that flushed records, or every run
# with CC_ANCHOR_TELEMETRY_OVERHEAD=1. bash >= 5 only (EPOCHREALTIME).
if [[ -n "$t0" && -n "${EPOCHREALTIME:-}" ]] && { (( flushed )) || [[ "${CC_ANCHOR_TELEMETRY_OVERHEAD:-}" == 1 ]]; }; then
  t1="$EPOCHREALTIME"; us=$(( 10#${t1/[.,]/} - 10#${t0/[.,]/} ))
  printf '{"schema":"cca.telemetry/1","session_id":"%s","observer":"%s","ev":"telemetry_overhead","at":"%s","hook":"%s","hook_ms":%d.%03d,"files":%d}\n' \
    "$sid_j" "$obs_j" "$now" "$ev_j" "$(( us / 1000 ))" "$(( us % 1000 ))" "${#files[@]}" >> "$out" 2>/dev/null
fi
exit 0
