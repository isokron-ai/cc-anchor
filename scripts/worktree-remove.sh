#!/usr/bin/env bash
# cc-anchor — WorktreeRemove hook (OPT-IN pack, paired with worktree-create.sh).
#
# Fires only for worktrees our WorktreeCreate hook made. Jobs:
#   1. sea-lite: every live claim whose session was taken while Claude was
#      working in this worktree (claims.json entries whose `cwd` is under
#      worktree_path — recorded by the PostToolUse hook when the payload's
#      cwd differs from the project root) is appended to pending-release.jsonl
#      so the next orient surfaces it. A hook cannot call sea_release (see
#      subagent-stop.sh for why).
#   2. Remove the directory: `git worktree remove --force` (falls back to
#      rm -rf) and delete the `worktree-<name>` branch we created, as the
#      reference asks ("If your WorktreeCreate hook creates a branch, delete
#      it in your WorktreeRemove hook").
#   3. Stamp: breadcrumb `WorktreeRemove <name>` + drop state.worktrees[path].
#
# Input (stdin, per hooks reference "WorktreeRemove input"):
#   { session_id, transcript_path, cwd, hook_event_name:"WorktreeRemove", worktree_path }
# Output: JSON is discarded. Exit 0 = removed; non-zero with the directory
#         still present = removal failed (we only exit non-zero in that case).
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 1
cc_have_jq || exit 0

input="$(cat 2>/dev/null || true)"
IFS=$'\x1f' read -r wtp cwd < <(jq -r '[(.worktree_path // ""), (.cwd // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || exit 0
[[ -n "${wtp:-}" ]] || exit 0
wtp="${wtp%/}"

cc_resolve "${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
name="${wtp##*/}"

# 1. claims taken from inside the worktree → pending releases
if [[ -s "$CC_CLAIMS" ]]; then
  live="$(cc_claims_live '*' | jq -c --arg p "$wtp" 'map(select((.cwd // "") | (. == $p) or startswith($p + "/")))' 2>/dev/null || echo '[]')"
  [[ "$live" != "[]" ]] && cc_pending_add "$live" "worktree $name removed while holding the claim"
fi

# 2. remove the worktree + its branch
repo="$(git -C "$CC_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -d "$wtp" ]]; then
  if [[ -n "$repo" ]]; then git -C "$repo" worktree remove --force "$wtp" >&2 2>/dev/null || rm -rf "$wtp"; else rm -rf "$wtp"; fi
fi
if [[ -n "$repo" ]]; then
  git -C "$repo" worktree prune >/dev/null 2>&1 || true
  git -C "$repo" branch -D "worktree-$name" >/dev/null 2>&1 || true
fi

# 3. stamp
cc_render "$(jq -nc --arg n "$name" --arg s "$(jq -r '.session_id // ""' <<<"$input")" '{hook_event_name:"PostToolUse",tool_name:"WorktreeRemove",tool_input:{description:$n},session_id:$s}')" 2>/dev/null
wt="$(cc_state_get worktrees)"; [[ -n "$wt" ]] && cc_state_set worktrees "$(jq -c --arg d "$wtp" 'del(.[$d])' <<<"$wt" 2>/dev/null || echo '{}')"
cc_log "WorktreeRemove: $name ($wtp)"
[[ -d "$wtp" ]] && exit 1
exit 0
