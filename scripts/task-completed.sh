#!/usr/bin/env bash
# cc-anchor — TaskCompleted hook (no matcher).
#
# Task mirror (config `task_mirror`, OPT-IN): move the mirrored sea-lite
# ticket to `resolved`. With `task_mirror_gate` on (default) the completion
# is BLOCKED (exit 2, reason on stderr — the only block channel the
# reference gives TaskCompleted when TaskUpdate triggered it) while the
# ticket still has an open predecessor in sea-lite (depends_on / blocks).
# Mirror failures never block. See scripts/task-mirror.mjs.
#
# Input (stdin, per hooks reference "TaskCompleted input"):
#   { session_id, transcript_path, cwd, permission_mode,
#     hook_event_name:"TaskCompleted", task_id, task_subject,
#     task_description?, teammate_name?, team_name?, agent_id? }
# Output: nothing on stdout. Exit 0, or 2 with the reason on stderr.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 0

input="$(cat 2>/dev/null || true)"
[[ -n "$input" ]] || exit 0
root="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$root" && "$input" =~ \"cwd\":[[:space:]]*\"([^\"]*)\" ]]; then root="${BASH_REMATCH[1]}"; fi
cc_resolve "${root:-$PWD}"

cc_on task_mirror 0 || exit 0
command -v node >/dev/null 2>&1 || { cc_log_once task_mirror_nonode "task_mirror: node not on PATH; skipping"; exit 0; }
cc_ensure_dirs || exit 0
gate="$(cc_cfg_raw task_mirror_gate)"
err="$(CC_ANCHOR_RUN="$CC_RUN" CC_ANCHOR_TASK_MIRROR_GATE="${gate:-1}" node "$CC_HERE/task-mirror.mjs" completed <<<"$input" 2>&1 >/dev/null)"; rc=$?
if [[ "$rc" == "2" && -n "$err" ]]; then printf '%s\n' "$err" >&2; exit 2; fi
[[ -n "$err" ]] && cc_log "task_mirror(completed): $err"
exit 0
