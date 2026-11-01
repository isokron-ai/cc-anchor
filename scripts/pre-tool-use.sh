#!/usr/bin/env bash
# cc-anchor — PreToolUse hook (matcher "Edit|Write|MultiEdit|NotebookEdit").
#
# sea-lite scope guard (config `scope_guard`, OPT-IN, default off). When on,
# an edit to a path that lies inside someone else's live sea-lite claim —
# another actor, or the same actor label in another Claude Code session —
# is denied with the holder, ticket, title, locked paths and expiry named.
#
# Only file-editing tools reach this hook. Edits made through the Bash tool
# (sed -i, redirects, formatters, codegen) bypass it; sea-lite's git
# pre-commit guard (`sea-lite precommit --install`) is the backstop.
#
# Budget: < 30 ms on the hot path. How:
#   * switch off (the default) => bash pattern match on the config file,
#     no jq, no fork: ~5 ms.
#   * switch on, verdict cached (<run>/scope-cache.json keyed by
#     "<session>|<file>", TTL config scope_ttl s, default 30) => ONE jq
#     call: ~15 ms. Keyed by session because sessions disagree: the holder's
#     "ok" must never answer for another session.
#   * cache miss => one `sea-lite scope-check` (node + sqlite, ~200-400 ms,
#     bounded by config scope_timeout s, default 4) and the verdict is
#     cached. The cache is dropped whenever a sea_* tool result passes
#     through PostToolUse (claims moved).
#
# Contract with the real CLI (sea-lite >= 0.4.0; hooks/README.md there):
#   sea-lite scope-check --json --session <session_id> [--actor A] [--data-dir D] <absolute file>
#   exit 0  → no conflict
#   exit 1  → conflict; stdout {schema:"sea-lite.scope-check/1", ok:false,
#             conflicts:[{ticket_id, title, holder, holder_session,
#             holder_label, held[], claim_expires_at, expires_in_seconds}]}
#   exit 2  → {error, details:{reason}}: reason "outside_repo" => allow
#             quietly; anything else => FAIL OPEN, logged once.
#   other / no JSON contract (sea-lite < 0.4.0) / missing binary / timeout
#           → FAIL OPEN, logged once, "ok" cached for the TTL.
# Identity: the session comes from the hook input's session_id (config
# `sea_session` overrides it — Cursor, whose conversation id is not the MCP
# server's session); sea-lite maps it to the identity this session's MCP
# server claims under. Given only a session, every claim of that session
# (main agent and subagents) is the hook's own. Config `sea_actor` adds
# --actor (then only that actor's claims are its own).
#
# Input (stdin, per hooks reference "PreToolUse input"): { session_id, cwd,
#   tool_name, tool_input:{file_path|notebook_path, …}, tool_use_id }
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

sid=""
if [[ "$input" =~ \"session_id\":[[:space:]]*\"([^\"]*)\" ]]; then sid="${BASH_REMATCH[1]}"; fi
ov="$(cc_cfg_raw sea_session)"; [[ -n "$ov" ]] && sid="$ov"
actor="$(cc_cfg_raw sea_actor)"
key="${sid}|${file}"

ttl="$(cc_cfg_raw scope_ttl)"; [[ "$ttl" =~ ^[0-9]+$ ]] || ttl=30
now_epoch="$(printf '%(%s)T' -1 2>/dev/null || date +%s)"

# ── cache lookup (one jq) ─────────────────────────────────────────────
verdict=""
if [[ -s "$CC_SCOPE_CACHE" ]]; then
  verdict="$(jq -c --arg f "$key" --argjson now "$now_epoch" --argjson ttl "$ttl" '
      .[$f] // empty | select(($now - .at) < $ttl)' "$CC_SCOPE_CACHE" 2>/dev/null || true)"
fi

if [[ -z "$verdict" ]]; then
  # ── cache miss: ask sea-lite ────────────────────────────────────────
  out=""; rc=0
  args=(scope-check --json)
  [[ -n "$sid" ]] && args+=(--session "$sid")
  [[ -n "$actor" ]] && args+=(--actor "$actor")
  [[ -n "${CC_ANCHOR_SEA_DATA_DIR:-}" ]] && args+=(--data-dir "$CC_ANCHOR_SEA_DATA_DIR")
  args+=("$file")
  if bin="$(cc_find_cli sea-lite)"; then
    to="$(cc_cfg_raw scope_timeout)"; [[ "$to" =~ ^[0-9]+$ ]] || to=4
    if [[ "$bin" == *.js || "$bin" == *.mjs ]]; then out="$(cc_with_timeout "$to" node "$bin" "${args[@]}" 2>/dev/null)"; rc=$?
    else out="$(cc_with_timeout "$to" "$bin" "${args[@]}" 2>/dev/null)"; rc=$?; fi
  else
    rc=127
  fi
  contract=0; [[ "$out" == *'"schema": "sea-lite.scope-check/'* || "$out" == *'"schema":"sea-lite.scope-check/'* ]] && contract=1
  case "$rc" in
    0) verdict='{"ok":true}';;
    1)
      if [[ "$contract" == 1 ]]; then
        verdict="$(jq -c '{ok:false, conflicts:[(.conflicts // [])[] | {holder:(.holder_label // .holder), ticket:(.ticket_id // ""), title:(.title // ""), held:(.held // []), expires:(.claim_expires_at // "")}]}' <<<"$out" 2>/dev/null)" || verdict=""
      fi
      if [[ -z "$verdict" ]]; then
        verdict='{"ok":true}'; cc_log_once scope_oldsea "scope_guard: sea-lite scope-check gave no JSON contract (sea-lite older than 0.4.0?); failing open for ${ttl}s. Upgrade sea-lite."
      fi;;
    2)
      verdict='{"ok":true}'
      if [[ "$contract" == 1 ]] && [[ "$(jq -r '.details.reason // ""' <<<"$out" 2>/dev/null)" == "outside_repo" ]]; then :
      else
        msg=""; [[ "$contract" == 1 ]] && msg="$(jq -r '.message // ""' <<<"$out" 2>/dev/null)"
        cc_log_once scope_err "scope_guard: sea-lite scope-check exited 2 (${msg:-unsupported subcommand or bad input}); failing open for ${ttl}s"
      fi;;
    127) verdict='{"ok":true}'; cc_log_once scope_nobin "scope_guard: sea-lite CLI not found; failing open";;
    *) verdict='{"ok":true}'; cc_log_once scope_unsupported "scope_guard: sea-lite scope-check exited $rc (crash or timeout); failing open for ${ttl}s";;
  esac
  # write back (best effort, atomic)
  cur='{}'; [[ -s "$CC_SCOPE_CACHE" ]] && cur="$(cat "$CC_SCOPE_CACHE" 2>/dev/null || echo '{}')"
  if cc_ensure_dirs && jq -c --arg f "$key" --argjson v "$verdict" --argjson now "$now_epoch" '
      (. // {}) | with_entries(select(($now - .value.at) < 3600)) | .[$f] = ($v + {at: $now})' <<<"$cur" > "$CC_SCOPE_CACHE.tmp.$$" 2>/dev/null; then
    mv -f "$CC_SCOPE_CACHE.tmp.$$" "$CC_SCOPE_CACHE"
  else
    rm -f "$CC_SCOPE_CACHE.tmp.$$"
  fi
fi

[[ "$verdict" == *'"ok":false'* ]] || exit 0

reason="$(jq -r --arg f "$file" '
  "cc-anchor scope guard: \($f) is inside a live sea-lite claim held by someone else — "
  + ((.conflicts // []) | map("\(.holder // "?") on ticket \((.ticket // "?") | .[0:8]) (\"\(.title // "")\"; locks \((.held // []) | join(", ")); expires \(.expires // "?"))") | join("; "))
  + ". Claim other work (sea_next), wait for the lease, or coordinate with the holder (sea-lite board). CC_ANCHOR_SCOPE_GUARD=0 disables this guard."' <<<"$verdict" 2>/dev/null)" || exit 0
cc_emit_deny "$reason"
exit 0
