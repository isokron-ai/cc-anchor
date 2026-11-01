#!/usr/bin/env bash
# cc-anchor — WorktreeCreate hook (OPT-IN pack: `anchor.mjs hooks install worktree`).
#
# NOT in the plugin's hooks.json on purpose: the hooks reference says a
# WorktreeCreate hook "replaces default git behavior … entirely" and must
# print the created worktree path as the last stdout line, or creation
# fails. A plugin that registered it for everyone would hijack every
# `--worktree` / EnterWorktree / isolation:"worktree" call. So this pack is
# installed into settings.json on request, and it reproduces the documented
# default (`.claude/worktrees/<name>` on a new branch `worktree-<name>`,
# branched from HEAD, plus `.worktreeinclude` copies) before adding the
# cc-anchor extras:
#
#   * stamps the card: a `WorktreeCreate <name>` breadcrumb on the trail and
#     state.worktrees[<path>] = {name, created} so the next injection shows
#     the session moved into a worktree (cwd follows Claude there while
#     $CLAUDE_PROJECT_DIR — and therefore the card — stays in the main
#     checkout, per the reference's "Worktrees are different" note);
#   * copies the card into <worktree>/.claude/anchor.md so a session that
#     later launches INSIDE the worktree (resume) is anchored too.
#
# Input (stdin, per hooks reference "WorktreeCreate input"):
#   { session_id, transcript_path, cwd, hook_event_name:"WorktreeCreate", name }
# Output: the absolute worktree path as the last non-empty stdout line.
#         Everything else goes to stderr. Non-zero exit => creation fails.
set -u
CC_HERE="${BASH_SOURCE[0]%/*}"; [[ "$CC_HERE" == "${BASH_SOURCE[0]}" ]] && CC_HERE=.
# shellcheck source=./lib.sh
. "$CC_HERE/lib.sh" || exit 1

input="$(cat 2>/dev/null || true)"
name=""; cwd=""
if cc_have_jq; then
  IFS=$'\x1f' read -r name cwd < <(jq -r '[(.name // ""), (.cwd // "")] | map(gsub("[\\x1f\\n]"; " ")) | join("\u001f")' <<<"$input" 2>/dev/null) || true
fi
[[ -n "$name" ]] || { echo "cc-anchor worktree-create: no name in hook input" >&2; exit 1; }
name="${name//[^A-Za-z0-9._-]/-}"

root="${CLAUDE_PROJECT_DIR:-${cwd:-$PWD}}"
cc_resolve "$root"
repo="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || { echo "cc-anchor worktree-create: $root is not a git repository" >&2; exit 1; }
# git prints the symlink-resolved path (macOS: /var → /private/var). When the
# project dir IS the toplevel, keep its spelling so the printed worktree path,
# state.worktrees keys and trail entries stay under $CLAUDE_PROJECT_DIR.
root="${root%/}"
[[ "$repo" != "$root" ]] && [[ "$(cd "$root" 2>/dev/null && pwd -P)" == "$repo" ]] && repo="$root"
dir="$repo/.claude/worktrees/$name"
branch="worktree-$name"

if [[ -d "$dir" ]]; then
  echo "cc-anchor worktree-create: $dir already exists; reusing" >&2
elif git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$repo" worktree add "$dir" "$branch" >&2 || exit 1
else
  git -C "$repo" worktree add -b "$branch" "$dir" HEAD >&2 || exit 1
fi

# .worktreeinclude: copy listed (gitignored) files, as the default would.
if [[ -s "$repo/.worktreeinclude" ]]; then
  while IFS= read -r pat || [[ -n "$pat" ]]; do
    pat="${pat%%#*}"; pat="${pat#"${pat%%[![:space:]]*}"}"; pat="${pat%"${pat##*[![:space:]]}"}"
    [[ -n "$pat" ]] || continue
    for f in "$repo"/$pat; do
      [[ -f "$f" ]] || continue
      rel="${f#"$repo"/}"; mkdir -p "$dir/$(dirname "$rel")" && cp -p "$f" "$dir/$rel" 2>/dev/null || true
    done
  done < "$repo/.worktreeinclude"
fi

# cc-anchor extras (all best effort).
if cc_have_jq; then
  cc_render "$(jq -nc --arg n "$name" --arg s "$(jq -r '.session_id // ""' <<<"$input")" '{hook_event_name:"PostToolUse",tool_name:"WorktreeCreate",tool_input:{description:$n},session_id:$s}')" 2>/dev/null
  wt="$(cc_state_get worktrees)"; [[ -n "$wt" ]] || wt='{}'
  cc_state_set worktrees "$(jq -c --arg d "$dir" --arg n "$name" --arg t "$(cc_now)" '. + {($d): {name:$n, created:$t}}' <<<"$wt" 2>/dev/null || echo '{}')"
  if [[ -s "$CC_CARD" ]]; then mkdir -p "$dir/.claude" && cp "$CC_CARD" "$dir/.claude/anchor.md" 2>/dev/null || true; fi
fi
cc_log "WorktreeCreate: $name → $dir"
printf '%s\n' "$dir"
exit 0
