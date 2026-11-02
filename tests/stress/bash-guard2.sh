#!/usr/bin/env bash
# Copied from agent-memory-bench hardening-hooks @ 386db8c (stress/cca/); cc-anchor 0.5.1 runs it from tests/stress.test.mjs.
# Round 2 (hardening track 3): more ways around the cc-anchor 0.5.0 Bash claimed-path guard.
# Reuses the setup/call helpers of bash-guard.sh (session sB edits inside sess-A's claim on src/auth).
# usage: CCA=<cc-anchor> SLBIN=<sea-lite>/dist/cli.js stress/cca/bash-guard2.sh [case]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source <(sed -n '1,/^if run control/p' "$HERE/bash-guard.sh" | sed '$d')
only=${1:-}
info() { echo "info $1"; }
log_tail() { grep -h 'bash_guard' "$P/.claude/cc-anchor/log" 2>/dev/null | tail -2 | sed 's/^/     log: /'; }

if run rm_parent; then setup; warm; out=$(call "rm -rf src"); expect_warn "rm -rf of the claim's PARENT dir" "$out" "src/auth"; done_; fi
if run mv_parent; then setup; warm; out=$(call "mv src src-old"); expect_warn "mv of the claim's PARENT dir away" "$out" "src/auth"; done_; fi
if run mv_claim; then setup; warm; out=$(call "mv src/auth src/auth-old"); expect_warn "mv of the claimed dir itself" "$out" "src/auth"; done_; fi
if run checkout_away; then setup; git -C "$P" checkout -q -b other; git -C "$P" rm -rq src; git -C "$P" -c user.name=t -c user.email=t@x commit -qm gone; git -C "$P" checkout -q -; warm
  out=$(call "git checkout -q other"); expect_warn "git checkout of a branch without the claimed dir" "$out" "src/auth"; done_; fi
if run git_stash; then setup; echo dirty >> "$P/src/auth/login.ts"; warm
  out=$(call "git stash -q"); expect_warn "git stash (reverts the holder's uncommitted work in the claim)" "$out" "login.ts"; done_; fi
if run bg_write; then setup; warm
  out=$(call "(sleep 2; echo late >> src/auth/login.ts) >/dev/null 2>&1 &"); sleep 3; out2=$(call "true")
  expect_warn "write by a background job that lands after the Bash call returned" "$out$out2" "login.ts"; done_; fi
if run gitignore_same_call; then setup; warm
  out=$(call "echo 'src/auth/' >> .gitignore; echo z >> src/auth/login.ts"); expect_warn "claimed path git-ignored in the same call" "$out" "login.ts"; done_; fi
if run ignored_claim; then CLAIM=config setup; mkdir -p "$P/config"; echo 'config/' > "$P/.gitignore"; echo a > "$P/config/local.env"; warm
  out=$(call "echo z >> config/local.env"); expect_warn "claim on a git-ignored path (config/)" "$out" "local.env"; done_; fi
# board call too slow once (scope_timeout 4 s): the cache is emptied and stamped "fresh" for bash_guard_ttl (30 s)
if run board_timeout; then setup; F=$W/slow-sl; printf '#!/bin/bash\n[ -e %q/slow ] && sleep 6\nexec node %q "$@"\n' "$W" "$SLBIN" > "$F"; chmod +x "$F"; export CC_ANCHOR_SEA_LITE_BIN=$F
  touch "$W/slow"; t="toolu_w$RANDOM"; pre sess-B "$t" true; post sess-B "$t" >/dev/null; rm -f "$W/slow"
  out=$(call "echo z >> src/auth/login.ts"); expect_warn "edit 2 s after ONE slow board call (sea-lite healthy again)" "$out" "login.ts"; log_tail
  export CC_ANCHOR_SEA_LITE_BIN=$SLBIN; done_; fi
if run no_tool_use_id; then setup; warm
  jq -nc --arg cwd "$P" '{session_id:"sess-B",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"x"},cwd:$cwd}' | bash "$CCA/scripts/pulse.sh" >/dev/null 2>&1
  (cd "$P" && echo z >> src/auth/login.ts)
  out=$(jq -nc --arg cwd "$P" '{session_id:"sess-B",hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:"x"},tool_response:{stdout:""},cwd:$cwd}' | bash "$CCA/scripts/post-tool-use.sh" 2>/dev/null)
  expect_warn "payload without tool_use_id" "$out" "login.ts"; done_; fi
if run same_session_subagent; then setup; warm
  # sess-A's claim; a SUBAGENT of sess-A (same session_id, its own agent_id) edits via Bash
  pre2() { jq -nc --arg t "$1" --arg c "$2" --arg cwd "$P" '{session_id:"sess-A",agent_id:"sub-2",hook_event_name:"PreToolUse",tool_name:"Bash",tool_use_id:$t,tool_input:{command:$c},cwd:$cwd}' | bash "$CCA/scripts/pulse.sh" >/dev/null 2>&1; }
  post2() { jq -nc --arg t "$1" --arg cwd "$P" '{session_id:"sess-A",agent_id:"sub-2",hook_event_name:"PostToolUse",tool_name:"Bash",tool_use_id:$t,tool_input:{command:"x"},tool_response:{stdout:""},cwd:$cwd}' | bash "$CCA/scripts/post-tool-use.sh" 2>/dev/null; }
  pre2 tsub1 "echo z >> src/auth/login.ts"; (cd "$P" && echo z >> src/auth/login.ts); out=$(post2 tsub1)
  [[ "$out" == *"bash guard"* ]] && info "subagent of the holder session is warned" || info "subagent sharing the holder's session_id edits the claim: no warning (claims are per session, not per agent)"; done_; fi
echo; echo "bash-guard2: pass=$pass fail=$fail"; exit $(( fail > 0 ))
