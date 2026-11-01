#!/usr/bin/env bash
# cc-anchor — PreToolUse hook (matcher "Edit|Write|MultiEdit|NotebookEdit").
#
# sea-lite scope guard (config `scope_guard`, OPT-IN, default off). When on,
# an edit to a path that lies inside another actor's live claim scope is
# denied with the holder, ticket and lease expiry named.
#
# Budget: < 30 ms on the hot path. How:
#   * switch off (the default) => bash pattern match on the config file,
#     no jq, no fork: ~5 ms.
#   * switch on, path verdict cached (<run>/scope-cache.json, TTL
#     config scope_ttl s, default 30) => ONE jq call: ~15 ms.
#   * cache miss => `sea-lite scope-check --paths <file>` (node + sqlite,
#     ~200-400 ms, bounded by config scope_timeout s, default 4) and the
#     verdict is cached. The cache is dropped whenever a sea_* tool result
#     passes through PostToolUse (claims moved).
#
# Contract with `sea-lite scope-check` (sea-lite ≥ 0.2):
#   exit 0  → no conflict
#   exit 1  → conflict; stdout JSON {conflicts:[{holder,ticket,paths,expires}]}
#   other   → unsupported subcommand / crash / timeout → FAIL OPEN, log once,
#             and cache "ok" for the TTL so we do not re-spawn on every edit.
# Never blocks when sea-lite is absent: missing binary => fail open, log once.
#
# Input (stdin, per hooks reference "PreToolUse input"): { …, tool_name,
#   tool_input:{file_path|notebook_path, …}, tool_use_id }
# Output (per "PreToolUse decision control"):
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
#   or nothing. (Top-level decision:"block" is deprecated for PreToolUse; it
#   maps to deny but we emit the current shape.) Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0

input=""
IFS= read -r -d '' input || true
[[ -n "$input" ]] || exit 0

root="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$root" && "$input" =~ \"cwd\":[[:space:]]*\"([^\"]*)\" ]]; then root="${BASH_REMATCH[1]}"; fi
cc_resolve "${root:-$PWD}"

cc_on scope_guard 0 || exit 0
cc_have_jq || exit 0

# Path straight from the payload with a bash regex (file_path is always
# absolute per the reference; backslashes on Windows are normalised).
file=""
if [[ "$input" =~ \"(file_path|notebook_path)\":[[:space:]]*\"([^\"]*)\" ]]; then file="${BASH_REMATCH[2]}"; fi
[[ -n "$file" ]] || exit 0
# A backslash means a JSON-escaped (Windows) path: decode it properly with jq
# (only then — the Linux/macOS hot path stays regex-only) and normalise to /.
if [[ "$file" == *\\* ]]; then
  file="$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$input" 2>/dev/null)"
  file="${file//\\//}"
fi

ttl="$(cc_cfg_raw scope_ttl)"; [[ "$ttl" =~ ^[0-9]+$ ]] || ttl=30
now_epoch="$(printf '%(%s)T' -1 2>/dev/null || date +%s)"

# ── cache lookup (one jq) ─────────────────────────────────────────────
verdict=""
if [[ -s "$CC_SCOPE_CACHE" ]]; then
  verdict="$(jq -c --arg f "$file" --argjson now "$now_epoch" --argjson ttl "$ttl" '
      .[$f] // empty | select(($now - .at) < $ttl)' "$CC_SCOPE_CACHE" 2>/dev/null || true)"
fi

if [[ -z "$verdict" ]]; then
  # ── cache miss: ask sea-lite ────────────────────────────────────────
  out=""; rc=0
  if bin="$(cc_find_cli sea-lite)"; then
    to="$(cc_cfg_raw scope_timeout)"; [[ "$to" =~ ^[0-9]+$ ]] || to=4
    tcmd=(); if command -v timeout >/dev/null 2>&1; then tcmd=(timeout "$to"); fi
    if [[ "$bin" == *.js ]]; then out="$(${tcmd[@]+"${tcmd[@]}"} node "$bin" scope-check --paths "$file" 2>/dev/null)"; rc=$?
    else out="$(${tcmd[@]+"${tcmd[@]}"} "$bin" scope-check --paths "$file" 2>/dev/null)"; rc=$?; fi
  else
    rc=127
  fi
  case "$rc" in
    0) verdict='{"ok":true}';;
    1) verdict="$(jq -c '{ok:false, conflicts:(.conflicts // [])}' <<<"$out" 2>/dev/null || echo '{"ok":true}')";;
    127) verdict='{"ok":true}'; cc_log_once scope_nobin "scope_guard: sea-lite CLI not found; failing open";;
    *) verdict='{"ok":true}'; cc_log_once scope_unsupported "scope_guard: sea-lite scope-check exited $rc (unsupported subcommand, crash or timeout); failing open for ${ttl}s";;
  esac
  # write back (best effort, atomic)
  cur='{}'; [[ -s "$CC_SCOPE_CACHE" ]] && cur="$(cat "$CC_SCOPE_CACHE" 2>/dev/null || echo '{}')"
  if cc_ensure_dirs && jq -c --arg f "$file" --argjson v "$verdict" --argjson now "$now_epoch" '
      (. // {}) | with_entries(select(($now - .value.at) < 3600)) | .[$f] = ($v + {at: $now})' <<<"$cur" > "$CC_SCOPE_CACHE.tmp.$$" 2>/dev/null; then
    mv -f "$CC_SCOPE_CACHE.tmp.$$" "$CC_SCOPE_CACHE"
  else
    rm -f "$CC_SCOPE_CACHE.tmp.$$"
  fi
fi

[[ "$verdict" == *'"ok":false'* ]] || exit 0

reason="$(jq -r --arg f "$file" '
  "cc-anchor scope guard: \($f) is inside the scope of a live sea-lite claim held by someone else — "
  + ((.conflicts // []) | map("\(.holder // "?") on ticket \(.ticket // "?") (paths: \((.paths // []) | join(", ")); expires \(.expires // "?"))") | join("; "))
  + ". Coordinate with the holder, wait for the lease, or claim the ticket yourself. CC_ANCHOR_SCOPE_GUARD=0 disables this guard."' <<<"$verdict" 2>/dev/null)" || exit 0
cc_emit_deny "$reason"
exit 0
