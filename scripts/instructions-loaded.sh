#!/usr/bin/env bash
# cc-anchor — InstructionsLoaded hook
# (matcher "session_start|compact|nested_traversal|path_glob_match|include").
#
# Measured on Claude Code 2.1.316: a PLUGIN's InstructionsLoaded hook does
# not fire for load_reason=session_start (the eager CLAUDE.md load happens
# before plugins register their hooks — the same ordering the reference
# documents for WorktreeCreate with --tmux); a settings.json hook does. Lazy
# loads (nested_traversal, path_glob_match, include) and compact reach the
# plugin hook, hence the wide matcher. Copy the hook into settings.json if
# you want the session_start stamp too (README "InstructionsLoaded").
#
# Observe-only event: the reference says its exit code is ignored and its
# JSON output fields are discarded, so this hook can neither inject the
# card nor block anything. It can only leave state behind. Two jobs:
#
#   1. Stamp: record which instruction files were loaded (CLAUDE.md,
#      .claude/rules/*.md), when, and why, in state.json
#      (instructions_files / instructions_loaded_at / instructions_reason)
#      and put a one-line "Instructions: …" on the card so the post-
#      compaction injection shows which instruction set was live.
#
#   2. Belt and braces for the compaction bracket: on load_reason=compact,
#      if SessionStart(compact) has NOT already re-injected the card for
#      this compaction (state.compact_injected_count != state.compact_count) — e.g. a SessionStart hook timed out,
#      another plugin's hook failed the group, or the two hooks raced —
#      set state.reassert_pending=1. The UserPromptSubmit hook then injects
#      the card with the next prompt (once) and clears the flag. This is the
#      only context channel left after SessionStart: InstructionsLoaded has
#      none, PostCompact discards output, and PreCompact only blocks.
#
# Input (stdin, per hooks reference "InstructionsLoaded input"):
#   { session_id, transcript_path, cwd, hook_event_name:"InstructionsLoaded",
#     file_path, memory_type, load_reason:"session_start"|"compact"|…, globs?,
#     trigger_file_path?, parent_file_path? }
# Output: nothing (discarded anyway). Exit 0 always.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\x1f' read -r cwd file reason < <(jq -r '[(.cwd // ""), (.file_path // ""), (.load_reason // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0
[[ -n "${file:-}" ]] || exit 0

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_ensure_dirs || exit 0

rel="$file"
[[ "$rel" == "$CC_ROOT/"* ]] && rel="${rel#"$CC_ROOT"/}"
now="$(cc_now)"

# Keep a short, de-duplicated list (max 6 names) of what was loaded.
cur="$(cc_state_get instructions_files)"
list="$(jq -rn --arg cur "$cur" --arg f "$rel" '
  ($cur | split(", ") | map(select(. != ""))) as $l
  | (if ($l | index($f)) == null then $l + [$f] else $l end) | .[-6:] | join(", ")')"
cc_state_set instructions_files "$list" instructions_loaded_at "$now" instructions_reason "$reason"

if [[ "$reason" == "compact" ]]; then
  # Compare compaction COUNTS, not timestamps: PreCompact, SessionStart and
  # this hook can all land in the same second.
  count="$(cc_state_get compact_count)"; injected="$(cc_state_get compact_injected_count)"
  if [[ -n "$count" && "$injected" != "$count" ]]; then
    cc_state_set reassert_pending 1
    cc_log "InstructionsLoaded(compact): SessionStart(compact) injection not seen for compaction #${count} (last injected: ${injected:-none}); reassert queued for next prompt"
  fi
fi

cc_render
exit 0
