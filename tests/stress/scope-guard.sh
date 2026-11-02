#!/usr/bin/env bash
# Copied from agent-memory-bench hardening-hooks @ 386db8c (stress/cca/); cc-anchor 0.5.1 runs it from tests/stress.test.mjs.
# Round 2 (hardening track 3): cc-anchor 0.5.0 Edit/Write scope guard (scripts/pre-tool-use.sh,
# opt-in scope_guard=1) — cache and fail-open paths. Session sess-B edits a file that sess-A claims.
# usage: CCA=<cc-anchor> SLBIN=<sea-lite>/dist/cli.js stress/cca/scope-guard.sh [case]
set -uo pipefail
CCA=${CCA:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}; SLBIN=${SLBIN:-$CCA/node_modules/sea-lite/dist/cli.js}; only=${1:-}
TMPROOT=${TMPROOT:-${TMPDIR:-/tmp}}
pass=0; fail=0
ok() { echo "ok   $1"; pass=$((pass+1)); }; bad() { echo "FAIL $1"; fail=$((fail+1)); }
run() { [[ -z "$only" || "$only" == "$1" ]]; }
setup() {
  W=$(mktemp -d "$TMPROOT/sg.XXXXXX"); P=$W/proj; mkdir -p "$P/src/auth" "$W/home"; git -C "$P" init -q; echo a > "$P/src/auth/login.ts"
  export HOME=$W/home KRONICLE_LITE_DATA_DIR=$W/sea CLAUDE_PROJECT_DIR=$P CC_ANCHOR_SEA_LITE_BIN=$SLBIN CC_ANCHOR_SEA=1 CC_ANCHOR_KRONICLE=0 CC_ANCHOR_SCOPE_GUARD=1
  printf '#!/bin/bash\n[ -e %q/slow ] && sleep 6\nexec node %q "$@"\n' "$W" "$SLBIN" > "$W/slow-sl"; chmod +x "$W/slow-sl"
}
claim() { local T; T=$(cd "$P" && node "$SLBIN" create "$1" --triaged --json | jq -r .ticket.id); (cd "$P" && node "$SLBIN" claim "$T" --paths "$2" --lease 900 --actor a --session sess-A >/dev/null); }
edit() { jq -nc --arg f "$1" --arg cwd "$P" '{session_id:"sess-B",hook_event_name:"PreToolUse",tool_name:"Edit",tool_use_id:"te",tool_input:{file_path:$f,old_string:"a",new_string:"b"},cwd:$cwd}' | bash "$CCA/scripts/pre-tool-use.sh" 2>/dev/null; }
expect_deny() { local o; o=$(edit "$2"); [[ "$o" == *'"deny"'* ]] && ok "$1" || bad "$1 :: Edit of a file in sess-A's claim allowed (out: ${o:0:80})"; }
done_() { rm -rf "$W"; }

if run control; then setup; claim T1 src/auth; expect_deny "control: Edit inside another session's claim" "$P/src/auth/login.ts"; done_; fi
if run fresh_claim; then setup; edit "$P/src/auth/login.ts" >/dev/null; claim T1 src/auth
  expect_deny "claim made right after an Edit of the same file (cached ok, scope_ttl 30 s)" "$P/src/auth/login.ts"; done_; fi
if run slow_once; then setup; claim T1 src/auth; export CC_ANCHOR_SEA_LITE_BIN=$W/slow-sl; touch "$W/slow"; edit "$P/src/auth/login.ts" >/dev/null; rm -f "$W/slow"
  expect_deny "Edit right after ONE slow scope-check (sea-lite healthy again)" "$P/src/auth/login.ts"; export CC_ANCHOR_SEA_LITE_BIN=$SLBIN; done_; fi
if run dotdot; then setup; claim T1 src/auth; expect_deny "file_path with a .. segment that stays in the repo" "$P/src/../src/auth/login.ts"; done_; fi
if run winpath; then setup; claim T1 src/auth; expect_deny "file_path with backslashes" "$(sed 's|/|\\|g' <<<"$P/src/auth/login.ts")"; done_; fi
for mode in missing garbage exit1 hang; do if run "failopen_$mode"; then setup; claim T1 src/auth; F=$W/fake-sl
  case $mode in missing) F=$W/nope;; garbage) printf '#!/bin/bash\necho "not json"; exit 0\n' > "$F";; exit1) printf '#!/bin/bash\necho "{oops"; exit 1\n' > "$F";;
    hang) printf '#!/bin/bash\n( sleep 40; echo late ) &\nsleep 40\n' > "$F";; esac; [[ -e "$F" ]] && chmod +x "$F"
  export CC_ANCHOR_SEA_LITE_BIN=$F; t0=$(date +%s%N); o1=$(edit "$P/src/auth/login.ts"); t1=$(( ($(date +%s%N)-t0)/1000000 ))
  t0=$(date +%s%N); o2=$(jq -nc --arg cwd "$P" '{session_id:"sess-B",hook_event_name:"PreToolUse",tool_name:"Bash",tool_use_id:"tq",tool_input:{command:"echo z >> src/auth/login.ts"},cwd:$cwd}' | bash "$CCA/scripts/pulse.sh" 2>/dev/null)
  (cd "$P" && echo z >> src/auth/login.ts)
  o3=$(jq -nc --arg cwd "$P" '{session_id:"sess-B",hook_event_name:"PostToolUse",tool_name:"Bash",tool_use_id:"tq",tool_input:{command:"x"},tool_response:{stdout:""},cwd:$cwd}' | bash "$CCA/scripts/post-tool-use.sh" 2>/dev/null); t2=$(( ($(date +%s%N)-t0)/1000000 ))
  v=1; for o in "$o1" "$o2" "$o3"; do [[ -z "$o" ]] || jq -e . >/dev/null 2>&1 <<<"$o" || v=0; done
  if (( t1 < 10000 && t2 < 10000 )) && [[ $v == 1 && "$o1$o2" != *deny* ]]; then ok "fail-open sea-lite=$mode: edit ${t1} ms, bash pre+post ${t2} ms, valid JSON, no block (warned: $([[ -n "$o1$o3" ]] && echo y || echo n))"
  else bad "fail-open sea-lite=$mode: edit ${t1} ms, bash ${t2} ms, json=$v, out=${o1:0:60}${o2:0:60}"; fi
  export CC_ANCHOR_SEA_LITE_BIN=$SLBIN; done_; fi; done
echo; echo "scope-guard: pass=$pass fail=$fail"; exit $(( fail > 0 ))
