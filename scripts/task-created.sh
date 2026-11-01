#!/usr/bin/env bash
# cc-anchor — TaskCreated hook (no matcher).
#
# Task mirror (config `task_mirror`, OPT-IN): create a sea-lite ticket for
# every Claude Code task, idempotency key `cc-task:<task_id>`. The work is
# done by scripts/task-mirror.mjs through the sea-lite library; this
# wrapper only checks the switch and finds node. Creation is never
# blocked by a mirror failure (the reference lets TaskCreated block with
# exit 2 / decision:block — we do not use it).
#
# Input (stdin, per hooks reference "TaskCreated input"):
#   { session_id, transcript_path, cwd, hook_event_name:"TaskCreated",
#     task_id, task_subject, task_description?, teammate_name?, team_name?, agent_id? }
# Output: nothing. Exit 0 always.
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
CC_ANCHOR_RUN="$CC_RUN" node "$CC_HERE/task-mirror.mjs" created <<<"$input" >/dev/null 2>>"$CC_LOG" || true
exit 0
