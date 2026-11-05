#!/usr/bin/env bash
# cc-anchor — audit telemetry (opt-in; benchmark accounting).
#
# Hook (Stop, SubagentStop, PreCompact, SessionEnd): reads only the
# transcript lines written since its last run (a byte offset per transcript
# file) and appends cca.telemetry/1 records (scripts/telemetry.jq) to the
# telemetry file. Nothing runs per tool call: tool sizes and latencies come
# from the transcript too, so PreToolUse / PostToolUse latency is unchanged.
#
# On when CC_ANCHOR_OBSERVER is `telemetry` or `telemetry+anchors`, or
# CC_ANCHOR_TELEMETRY=1. Otherwise this exits before reading anything.
#   CC_ANCHOR_OBSERVER       off | telemetry | telemetry+anchors (observer-
#                            effect arms; `off` and `telemetry` also make
#                            every other cc-anchor hook a no-op, see lib.sh)
#   CC_ANCHOR_TELEMETRY_FILE JSONL path (default <run dir>/telemetry.jsonl)
#   CC_ANCHOR_TELEMETRY_FORMAT  cca (default) | kronicle (draft kronicle-lite
#                            audit events: call_measured, turn_usage, …)
#
# Offline (no hook, no observer effect — e.g. the `off` arm):
#   bash scripts/telemetry.sh --scan <transcript.jsonl> [--subagents] [--kronicle]
# prints the records for the whole transcript (and its subagents/*.jsonl).
#
# Every record of a hook run is followed by one `telemetry_overhead` record
# (hook_ms: this hook's own wall time). Fail-open: exit 0, no stdout.
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
    jq -nc -R --arg sid "${tx##*/}" --arg agent "$ag" --arg observer "" --arg tx "$b" --arg ev scan --arg fmt "$fmt" \
      -f "$CC_HERE/telemetry.jq" < "$f" || exit 1
  done
  exit 0
fi

case "${CC_ANCHOR_OBSERVER:-}" in
  telemetry|telemetry+anchors) ;;
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
off_dir="$CC_RUN/telemetry.off"; mkdir -p "$off_dir" 2>/dev/null || exit 0
mkdir -p "${out%/*}" 2>/dev/null || true

# Which transcripts this event flushes (each keeps its own offset, so no
# API response is counted twice whichever event reads it first).
files=()
case "$ev" in
  SubagentStop) [[ -n "$atx" ]] && files+=("$atx|$agent");;
  SessionEnd)   [[ -n "$tx" ]] && files+=("$tx|")
                for f in "${tx%.jsonl}"/subagents/agent-*.jsonl; do
                  [[ -s "$f" ]] || continue; aid="${f##*/agent-}"; files+=("$f|${aid%.jsonl}"); done;;
  *)            [[ -n "$tx" ]] && files+=("$tx|");;
esac

now=""; cc_now_var now
for spec in ${files[@]+"${files[@]}"}; do  # bash 3.2 + set -u: an empty array is unbound
  f="${spec%|*}"; ag="${spec##*|}"
  [[ -s "$f" ]] || continue
  key="${f##*/}"; key="${key//[^A-Za-z0-9._-]/_}"; of="$off_dir/$key"
  off=0; [[ -s "$of" ]] && IFS= read -r off < "$of"; [[ "$off" =~ ^[0-9]+$ ]] || off=0
  size="$(wc -c < "$f" 2>/dev/null)"; size="${size//[^0-9]/}"; [[ -n "$size" ]] || continue
  (( size < off )) && off=0            # truncated / rewritten: start over
  (( size > off )) || continue
  chunk="$CC_RUN/telemetry.chunk.$$"
  tail -c +"$((off + 1))" "$f" 2>/dev/null | head -c "$((size - off))" > "$chunk" 2>/dev/null || { rm -f "$chunk"; continue; }
  # A line still being written stays for the next run.
  part=0; [[ "$(tail -c 1 "$chunk" 2>/dev/null | od -An -c 2>/dev/null)" == *'\n'* ]] || part="$(tail -n 1 "$chunk" | wc -c)"
  part="${part//[^0-9]/}"
  jq -nc -R --arg sid "$sid" --arg agent "$ag" --arg observer "$obs" --arg tx "${f##*/}" --arg ev "$ev" --arg now "$now" --arg fmt "$fmt" \
    -f "$CC_LIB_DIR/telemetry.jq" < <(head -c "$(( size - off - part ))" "$chunk") >> "$out" 2>/dev/null \
    && printf '%s\n' "$(( size - part ))" > "$of.$$" && mv -f "$of.$$" "$of"
  rm -f "$chunk" 2>/dev/null
done

# Hand-built records: only [A-Za-z0-9._+-] reaches them (no quoting needed).
sid_j="${sid//[^A-Za-z0-9._-]/}"; obs_j="${obs//[^A-Za-z0-9._+-]/}"; ev_j="${ev//[^A-Za-z]/}"
if [[ "$ev" == "PreCompact" ]]; then
  trig=""; [[ "$input" =~ \"trigger\":[[:space:]]*\"([a-z]+)\" ]] && trig="${BASH_REMATCH[1]}"
  printf '{"schema":"cca.telemetry/1","session_id":"%s","agent_id":null,"observer":"%s","ev":"compact_start","at":"%s","trigger":"%s"}\n' \
    "$sid_j" "$obs_j" "$now" "$trig" >> "$out" 2>/dev/null
fi

# This hook's own cost, from just after bash started to here (bash startup,
# a few ms, is not included). Not written when nothing was flushed.
if [[ -n "$t0" && -n "${EPOCHREALTIME:-}" ]] && (( ${#files[@]} > 0 )); then
  t1="$EPOCHREALTIME"; us=$(( 10#${t1/[.,]/} - 10#${t0/[.,]/} ))
  printf '{"schema":"cca.telemetry/1","session_id":"%s","observer":"%s","ev":"telemetry_overhead","at":"%s","hook":"%s","hook_ms":%d.%03d,"files":%d}\n' \
    "$sid_j" "$obs_j" "$now" "$ev_j" "$(( us / 1000 ))" "$(( us % 1000 ))" "${#files[@]}" >> "$out" 2>/dev/null
fi
exit 0
