#!/usr/bin/env bash
# The pending gate end to end with the real kronicle-lite 0.8.0 CLI. From agent-memory-bench
# stress/cca/gate.sh (hardening round 2, track 3: 29 checks, 17 failed on cc-anchor 0.5.0), kept
# verbatim, plus the 0.5.1 semantics (section "0.5.1" at the end): with nothing pending nothing is
# denied; with something pending every call that is not read-only is denied, read-only ones run.
# Each case: temp HOME + project, a runbook read by the agent's actor, then changed by another
# actor, so `kronicle-lite pending --actor <agent>` = 1. Never touches the real HOME.
# usage: tests/stress/gate.sh [case]     (CCA=<cc-anchor>, default this repo; KLBIN=<kl>/dist/cli.js,
#        default ./node_modules/kronicle-lite/dist/cli.js)
set -uo pipefail
CCA=${CCA:-$(cd "$(dirname "$0")/../.." && pwd)}; KLBIN=${KLBIN:-$CCA/node_modules/kronicle-lite/dist/cli.js}; only=${1:-}
[[ -f "$KLBIN" ]] || { echo "kronicle-lite CLI not found at $KLBIN (npm i --no-save kronicle-lite@0.8.0, or set KLBIN)"; exit 2; }
TMPROOT=${TMPROOT:-${TMPDIR:-/tmp}}
pass=0; fail=0; export SID=sess-0001-aaaa
ok() { echo "ok   $1"; pass=$((pass+1)); }; bad() { echo "FAIL $1"; fail=$((fail+1)); }
run() { [[ -z "$only" || "$only" == "$1" ]]; }
kl() { (cd "$P" && node "$KLBIN" "$@" --data-dir "$DD"); }
# setup [mcp-json-jq-filter] — $MCP: jq program producing the .mcp.json given $kl $dd
setup() {
  W=$(mktemp -d "$TMPROOT/gate.XXXXXX"); P=$W/proj; DD=$W/kl; mkdir -p "$P/.claude" "$W/home"; git -C "$P" init -q
  export HOME=$W/home CLAUDE_PROJECT_DIR=$P CC_ANCHOR_KRONICLE_LITE_BIN=$KLBIN CC_ANCHOR_SEA=0
  # a CLI wrapper the cases can slow down / break: touch $W/slow (sleep 5 s) or $W/broken (exit 1)
  printf '#!/bin/bash\n[ -e %q/slow ] && sleep 5\n[ -e %q/broken ] && { echo "{oops"; exit 1; }\nexec node %q "$@"\n' "$W" "$W" "$KLBIN" > "$W/klwrap"; chmod +x "$W/klwrap"
  [[ -n "${WRAP:-}" ]] && export CC_ANCHOR_KRONICLE_LITE_BIN=$W/klwrap
  unset CC_ANCHOR_KRONICLE_ACTOR CC_ANCHOR_PULSE_MODE KRONICLE_LITE_ACTOR KRONICLE_LITE_DATA_DIR
  local f=${MCP:-'{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd,"--actor","agent-a"]}}}'}
  jq -n --arg kl "$KLBIN" --arg dd "$DD" "$f" > "${MCPFILE:-$P/.mcp.json}"
  printf '# Runbook\n\n## Deploy\n\nDeploy to stg-west-2.\n' > "$W/r.md"; kl put runbook "$W/r.md" --actor ops >/dev/null
  kl get runbook --actor "${READER:-agent-a}" >/dev/null
  hook session-start.sh SessionStart >/dev/null; hook post-tool-use.sh PostToolUse >/dev/null
  printf '# Runbook\n\n## Deploy\n\nDeploy to stg-east-1.\n' > "$W/r.md"; kl put runbook "$W/r.md" --actor ops >/dev/null
}
hook() { # script event [agent] [extra-json]
  local s=$1 ev=$2 ag=${3:-} x=${4:-'{}'}
  jq -nc --arg ev "$ev" --arg a "$ag" --arg cwd "$P" --argjson x "$x" \
    '{session_id:"sess-0001-aaaa",hook_event_name:$ev,cwd:$cwd,source:"startup",tool_name:"Read",tool_use_id:"t1",tool_input:{file_path:"x"},tool_response:{}} + (if $a=="" then {} else {agent_id:$a,agent_type:"general-purpose"} end) + $x' \
  | bash "$CCA/scripts/$s" 2>/dev/null
}
pulse() { # command [agent]
  jq -nc --arg c "$1" --arg a "${2:-}" --arg cwd "$P" '{session_id:($ENV.SID // "sess-0001-aaaa"),hook_event_name:"PreToolUse",cwd:$cwd,tool_name:"Bash",tool_use_id:("tb"+($c|length|tostring)),tool_input:{command:$c}} + (if $a=="" then {} else {agent_id:$a,agent_type:"general-purpose"} end)' \
  | bash "$CCA/scripts/pulse.sh" 2>/dev/null
}
pend() { kl pending --actor "${1:-agent-a}" --cwd "$P" --json 2>/dev/null | jq -r .pending_count; }
expect_allow() { # name command [agent] — allowed: no deny (context is fine)
  local o; o=$(pulse "$2" "${3:-}")
  if [[ "$o" != *'"deny"'* ]]; then ok "$1"; else bad "$1 :: pulse denied \`$2\` (out: ${o:0:160})"; fi; }
reason() { pulse "$1" "${2:-}" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""'; }
expect_deny() { # name command [agent]
  local o; o=$(pulse "$2" "${3:-}")
  if [[ "$o" == *'"deny"'* ]]; then ok "$1"; else bad "$1 :: pending($(pend "${PA:-agent-a}"))>0 but pulse allowed \`$2\` (out: ${o:0:100})"; fi; }
done_() { [[ -n "${KEEP:-}" ]] && echo "kept $W" || rm -rf "$W"; }

if run control; then setup; expect_deny "control: git push denied while pending" "git push"; done_; fi

if run assign; then setup
  for c in 'TAG=v1.2.3; git push origin "$TAG"' 'set -e; DIR=infra; terraform -chdir=$DIR apply -auto-approve' \
           'git push; RC=$?' 'NS=prod\nkubectl -n $NS apply -f k8s/' 'npm publish && DONE=1'; do
    expect_deny "assignment-only segment: $(printf '%q' "$c" | cut -c1-50)" "$(printf '%b' "$c")"; done; done_; fi

if run heredoc; then setup
  expect_deny "hyphenated here-doc delimiter, push after" $'cat > notes.md <<\'END-NOTES\'\nhello\nEND-NOTES\ngit push'
  expect_deny "C++ '<<endl' in a quoted string, push after" $'printf \'std::cout<<endl;\\n\' >> main.cpp\ngit push'
  expect_deny "here-string, push after" $'wc -w <<<hello\ngit push'; done_; fi

if run source; then setup; expect_deny "source ./scripts/deploy.sh" "source ./scripts/deploy.sh"; expect_deny "process substitution" "cat <(./deploy.sh)"; done_; fi
if run makej; then setup; expect_deny "make -j release" "make -j release"; done_; fi

# --- actor resolution: the gate must check the actor whose reads kronicle-lite recorded
if run actor_eq; then MCP='{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd,"--actor=agent-a"]}}}' setup
  expect_deny "actor via --actor=agent-a (kl accepts the = form)" "git push"; done_; fi
if run datadir_eq; then MCP='{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir="+$dd,"--actor","agent-a"]}}}' setup
  expect_deny "data dir via --data-dir=DIR" "git push"; done_; fi
if run server_key; then MCP='{mcpServers:{"memory":{command:"kronicle-lite",args:["serve","--data-dir",$dd,"--actor","agent-a"]}}}' setup
  expect_deny "server key 'memory', command kronicle-lite (detected as configured)" "git push"; done_; fi
if run env_actor; then MCP='{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd],env:{KRONICLE_LITE_ACTOR:"agent-a"}}}}' setup
  expect_deny "actor via env KRONICLE_LITE_ACTOR in .mcp.json" "git push"; done_; fi
if run home_cfg; then MCPFILE=/dev/null setup; rm -f "$P/.mcp.json"
  jq -n --arg kl "$KLBIN" --arg dd "$DD" --arg p "$P" '{projects:{($p):{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd,"--actor","agent-a"]}}}}}' > "$HOME/.claude.json"
  rm -rf "$P/.claude/cc-anchor/push"; hook session-start.sh SessionStart >/dev/null
  expect_deny "~/.claude.json per-project server (temp HOME)" "git push"; done_; fi
if run home_cfg_symlink; then MCPFILE=/dev/null setup; rm -f "$P/.mcp.json"; ln -s "$P" "$W/link"
  jq -n --arg kl "$KLBIN" --arg dd "$DD" --arg p "$P" '{projects:{($p):{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd,"--actor","agent-a"]}}}}}' > "$HOME/.claude.json"
  rm -rf "$P/.claude/cc-anchor/push"; P0=$P; P=$W/link; export CLAUDE_PROJECT_DIR=$P; hook session-start.sh SessionStart >/dev/null
  expect_deny "~/.claude.json keyed by the physical path, CLAUDE_PROJECT_DIR via a symlink" "git push"; P=$P0; done_; fi
if run cc_actor_env; then setup; export CC_ANCHOR_KRONICLE_ACTOR=agent-a; rm -rf "$P/.claude/cc-anchor/push"; hook session-start.sh SessionStart >/dev/null
  expect_deny "CC_ANCHOR_KRONICLE_ACTOR=agent-a" "git push"; unset CC_ANCHOR_KRONICLE_ACTOR; done_; fi
# the agent passes its own actor_id on an MCP call that is NOT a read: the gate follows it
if run actor_switch; then setup
  hook post-tool-use.sh PostToolUse "" '{"tool_name":"mcp__kronicle-lite__get_system_state","tool_input":{"actor_id":"claude"}}' >/dev/null
  expect_deny "agent passes actor_id 'claude' to get_system_state (reads were recorded as agent-a)" "git push"; done_; fi
if run actor_switch_memkey; then MCP='{mcpServers:{"memory":{command:"node",args:[$kl,"serve","--data-dir",$dd]}}}' READER=claude setup
  # server key without "kronicle": the agent's actor_id on mcp__memory__* calls is never learned
  hook post-tool-use.sh PostToolUse "" '{"tool_name":"mcp__memory__recall","tool_input":{"query":"deploy","actor_id":"claude"}}' >/dev/null
  PA=claude expect_deny "agent reads as actor_id 'claude' through server key 'memory'" "git push"; done_; fi

# --- subagents
if run sub_actor; then READER=sub-1 setup
  hook subagent-start.sh SubagentStart ag-1 >/dev/null
  hook post-tool-use.sh PostToolUse ag-1 '{"tool_name":"mcp__kronicle-lite__recall","tool_input":{"query":"deploy","actor_id":"sub-1"}}' >/dev/null
  PA=sub-1 expect_deny "subagent with its own actor_id sub-1: gated on sub-1" "git push" ag-1
  o=$(pulse "git push"); [[ "$o" == *deny* ]] && bad "parent (agent-a, no reads) denied for sub-1's pending" || ok "parent not gated on the subagent's actor"; done_; fi
if run sub_nostart; then setup
  expect_deny "subagent with no SubagentStart, first call is the deploy" "git push" ag-9; done_; fi

# --- reconciling: a re-read clears; nothing else should
if run reread; then setup; kl get runbook --actor agent-a >/dev/null
  o=$(pulse "git push"); [[ "$o" != *deny* ]] && ok "re-read clears the gate" || bad "re-read did not clear: ${o:0:100}"; done_; fi
if run retry; then setup; pulse "git push" >/dev/null; expect_deny "plain retry still denied" "git push"; done_; fi

# --- warn mode / compaction / resume
if run compact; then setup; hook session-start.sh SessionStart "" '{"source":"compact"}' >/dev/null; expect_deny "after compaction SessionStart" "git push"; done_; fi
if run resume; then setup; hook session-start.sh SessionStart "" '{"source":"resume"}' >/dev/null; expect_deny "after resume SessionStart" "git push"; done_; fi
if run clear; then setup; hook session-start.sh SessionStart "" '{"source":"clear","session_id":"sess-0002-bbbb"}' >/dev/null; SID=sess-0002-bbbb expect_deny "after /clear (new session id)" "git push"; done_; fi

# --- 0.5.1: no false alarms with nothing pending (H2-07), read-only allowlist with something pending
FALSE_ALARMS=('npm ci && chmod +x scripts/deploy.sh' 'make && git checkout release/2.0' 'git switch -c deploy-fix' 'npm test -- deploy.test.ts'
  'kubectl get deploy' 'gh release list' 'docker build -t app:release .' "python3 -c 'print(1)'" 'A=1; echo "$A"')
if run nothing_pending; then setup; kl get runbook --actor agent-a >/dev/null
  for c in "${FALSE_ALARMS[@]}"; do expect_allow "nothing pending: \`$c\` runs" "$c"; done
  expect_allow "nothing pending: the same chain again (no once-only or every-retry denial)" 'npm ci && chmod +x scripts/deploy.sh'
  expect_allow "nothing pending: a world-changing command runs" "git push"; done_; fi
if run pending_nonro; then setup
  for c in 'npm test' 'make' 'git checkout release/2.0' 'sed -i s/a/b/ x' 'echo hi > notes.md' "python3 -c 'print(1)'"; do expect_deny "pending: not read-only \`$c\` denied" "$c"; done; done_; fi
if run pending_ro; then setup
  for c in 'cat runbook.md' 'git status && git log --oneline -3' 'grep -rn "deploy" docs/ 2>/dev/null | head -20' 'ls -la' \
           "find . -name '*.md' -not -path './node_modules/*'" "node $KLBIN pending --actor agent-a --json"; do
    expect_allow "pending: read-only \`$c\` runs" "$c"; done
  [[ "$(pend)" == 1 ]] && ok "pending: the read-only calls did not clear it" || bad "pending changed to $(pend)"; done_; fi
if run message; then setup; r=$(reason "npm run deploy")
  [[ "$r" == *"runbook › Runbook › Deploy"* && "$r" == *'read "Deploy to stg-west-2." → now "Deploy to stg-east-1."'* ]] && ok "deny names doc › heading and read → current" || bad "deny text: ${r:0:300}"
  [[ "$r" == *"you read it at seq"* ]] && ok "deny names the version read" || bad "no read version: ${r:0:300}"
  [[ "$r" == *"that clears this check by itself"* && "$r" == *"only read-only Bash commands run"* && "$r" == *"\`npm\` is not on the read-only list"* ]] && ok "deny says re-reading clears it, what still runs and why this call does not" || bad "deny text: ${r:0:400}"; done_; fi
if run reread_cli; then setup; expect_allow "pending: \`kronicle-lite get\` (read-only) is allowed" "node $KLBIN get runbook --actor agent-a --data-dir $DD"
  kl get runbook --actor agent-a >/dev/null; expect_allow "after that re-read, \`npm run deploy\` runs" "npm run deploy"; done_; fi
if run union_sub; then setup
  hook post-tool-use.sh PostToolUse ag-2 '{"tool_name":"mcp__kronicle-lite__recall","tool_input":{"query":"deploy","actor_id":"sub-2"}}' >/dev/null
  expect_deny "subagent naming its own actor is still gated on the configured actor's pending" "git push" ag-2; done_; fi
if run fail_closed; then setup; pulse "git push" >/dev/null
  printf '#!/usr/bin/env bash\nexit 1\n' > "$W/broken-kl"; chmod +x "$W/broken-kl"
  cfg="$P/.claude/cc-anchor/push/sess0001.cfg"; { sed -n 1p "$cfg"; echo "$W/broken-kl"; sed -n 3p "$cfg"; } > "$cfg.n" && mv "$cfg.n" "$cfg"
  touch "$DD/kronicle-lite.db"
  expect_deny "pending known, kronicle-lite now failing: fail closed on the last answer" "git push"
  expect_allow "…read-only still runs" "cat runbook.md"; done_; fi
if run fail_open; then WRAP=1 MCPFILE=/dev/null setup; rm -rf "$P/.claude/cc-anchor/push"; touch "$W/broken"
  export SID=sess-0009-zzzz CC_ANCHOR_KRONICLE=1 CC_ANCHOR_KRONICLE_DATA_DIR=$DD
  expect_allow "kronicle-lite broken since the session started (never an answer): fail open" "git push"
  unset CC_ANCHOR_KRONICLE CC_ANCHOR_KRONICLE_DATA_DIR; export SID=sess-0001-aaaa; done_; fi
if run big; then setup; big="printf %s '$(head -c 102400 /dev/zero | tr '\0' x)' > f; git push"
  s=$(date +%s); expect_deny "100 KB command then git push (H2-09): denied, not timed out" "$big"; e=$(date +%s)
  (( e - s < 8 )) && ok "100 KB command classified in $((e - s)) s (< 8 s; hook timeout 15 s)" || bad "100 KB command took $((e - s)) s"; done_; fi
if run warn; then setup; export CC_ANCHOR_PULSE_MODE=warn; o=$(pulse "git push"); unset CC_ANCHOR_PULSE_MODE
  [[ "$o" != *deny* && "$o" == *"pulse (warn)"* ]] && ok "pulse_mode=warn: allowed with the pending list as context" || bad "warn: ${o:0:160}"; done_; fi

# --- round 2, part 2 (agent-memory-bench 386db8c): back-off, offline, subagent stop/resume, ack
if run backoff; then WRAP=1 setup  # klpend cached with count 0 (before the change); store now has pending 1
  touch "$W/slow"; t0=$(date +%s); hook post-tool-use.sh PostToolUse >/dev/null; t=$(( ($(date +%s)-t0)*1000 )); rm -f "$W/slow"
  echo "     one slow read: post-tool-use ${t} ms (push_timeout 3 s); store healthy again, pending(agent-a)=$(pend)"
  expect_deny "H2-11: deploy within 60 s of ONE slow read (store healthy again, pending 1)" "git push"; done_; fi
if run backoff_broken; then WRAP=1 setup; touch "$W/slow"; hook post-tool-use.sh PostToolUse >/dev/null; rm -f "$W/slow"; touch "$W/broken"
  r=$(reason "git push")
  [[ "$r" == *"could not be read just now"* ]] && ok "H2-11: in the back-off with the CLI now failing: denied, the cached 0 is not 'clear'" || bad "back-off + broken CLI: ${r:0:160}"
  export CC_ANCHOR_PULSE_MODE=warn; o=$(pulse "git push"); unset CC_ANCHOR_PULSE_MODE
  [[ "$o" != *'"deny"'* && "$o" == *"could not be read just now"* ]] && ok "…warn mode: warned" || bad "warn: ${o:0:160}"
  expect_allow "…read-only still runs" "cat runbook.md"; done_; fi
if run offline; then WRAP=1 setup; touch "$W/broken"; n=0; first=0
  for i in $(seq 1 30); do o=$(hook post-tool-use.sh PostToolUse); if [[ "$o" == *"offline for"* ]]; then n=$((n+1)); (( first )) || first=$i; fi; done
  [[ $n == 1 ]] && ok "feed-offline advisory given once (at call $first of 30)" || bad "feed-offline advisory given $n times in 30 broken calls"
  # 0.5.0 failed open here "by design"; since 0.5.1 (H2-11) a store that changed since the last answer and cannot be read denies
  o=$(pulse "git push"); [[ "$o" == *'"deny"'* && "$o" == *"could not be read just now"* ]] && ok "pulse fails closed while the CLI is broken and the store changed (H2-11)" || bad "pulse with a broken CLI: ${o:0:160}"; done_; fi
if run substop_pending; then READER=sub-1 setup; hook subagent-start.sh SubagentStart ag-1 >/dev/null
  hook post-tool-use.sh PostToolUse ag-1 '{"tool_name":"mcp__kronicle-lite__recall","tool_input":{"query":"deploy","actor_id":"sub-1"}}' >/dev/null
  hook subagent-stop.sh SubagentStop ag-1 >/dev/null; left=$(ls "$P/.claude/cc-anchor/push" | grep 'a-ag-1' | grep -v '\.actors$' | tr '\n' ' ')
  [[ -z "$left" && -s "$P/.claude/cc-anchor/push/sess0001.a-ag-1.actors" ]] && ok "SubagentStop drops the subagent's cursor files, keeps the actors it read as" || bad "SubagentStop left: ${left:-none}; actors kept: $(cat "$P/.claude/cc-anchor/push/sess0001.a-ag-1.actors" 2>/dev/null)"
  hook subagent-start.sh SubagentStart ag-1 >/dev/null; PA=sub-1 expect_deny "H2-10: agent_id reused after stop, first call is a deploy (actor sub-1 still pending)" "git push" ag-1; done_; fi
if run ack; then setup
  for c in "node $KLBIN shim ack --through 7" "npx -y kronicle-lite@0.8.0 shim ack" 'kronicle-lite shim uninstall' "A=1 kronicle-lite shim 'ack'" "node $KLBIN pending ack"; do
    r=$(reason "$c"); [[ "$r" == *"operator's decision"* && "$r" == *"Re-read the pending items"* ]] && ok "H2-12: \`${c:0:40}\` denied as operator-only" || bad "H2-12: \`$c\`: ${r:0:120}"; done
  kl get runbook --actor agent-a >/dev/null
  r=$(reason "kronicle-lite shim ack"); [[ "$r" == *"operator's decision"* ]] && ok "H2-12: denied with nothing pending too" || bad "H2-12 nothing pending: ${r:0:120}"
  expect_allow "H2-12: \`kronicle-lite shim status\` is not an override" "kronicle-lite shim status"; done_; fi

# --- hardening-live (L2-02 … L2-04)
tamper() { # block | event | garbage — rewrite the store under kronicle-lite (python3 sqlite3)
  python3 -I - "$DD/kronicle-lite.db" "$1" <<'PY'
import sqlite3, sys
k = sys.argv[2]
if k == 'garbage':
    f = open(sys.argv[1], 'r+b'); f.seek(4096 * 2); f.write(b'\x00' * 4096); f.close(); sys.exit()
c = sqlite3.connect(sys.argv[1])
if k == 'block': c.execute("update blocks set content=replace(content,'stg-east-1','stg-evil-9')")
if k == 'event': c.execute("update events set payload_canonical=replace(payload_canonical,'stg-east-1','stg-evil-9')")
c.commit()
PY
}
for k in block event garbage; do if run "tamper_$k"; then setup; kl get runbook --actor agent-a >/dev/null; hook post-tool-use.sh PostToolUse >/dev/null
  [[ "$(pend)" == 0 ]] || bad "tamper_$k: setup expected nothing pending"
  tamper "$k"
  o=$(hook post-tool-use.sh PostToolUse)
  [[ "$o" == *"STORE INTEGRITY FAILURE"* ]] && ok "L2-02/L2-03 ($k): the push warns at once (head seq unchanged)" || bad "tamper $k: push said: ${o:0:160}"
  r=$(reason "git push"); [[ "$r" == *"STORE INTEGRITY FAILURE"* ]] && ok "L2-02/L2-03 ($k): git push denied with the integrity text" || bad "tamper $k: pulse: ${r:0:160}"
  expect_allow "…read-only still runs ($k)" "cat runbook.md"; done_; fi; done
if run actor_unnamed; then MCP='{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd]}}}' setup  # agent-a read, server actor unknown
  hook post-tool-use.sh PostToolUse >/dev/null   # the push delivers the change
  r=$(reason "./bin/deploy --target stg-west-2")
  [[ "$r" == *"stg-east-1"* && "$r" == *"CC_ANCHOR_KRONICLE_ACTOR"* ]] && ok "L2-04: actor not named anywhere: the retraction rule still denies and says how to name it" || bad "actor unnamed: ${r:0:200}"; done_; fi
if run claude_config_dir; then MCPFILE=/dev/null setup; rm -f "$P/.mcp.json"; export CLAUDE_CONFIG_DIR=$W/cfgdir; mkdir -p "$CLAUDE_CONFIG_DIR"
  jq -n --arg kl "$KLBIN" --arg dd "$DD" --arg p "$P" '{projects:{($p):{mcpServers:{"kronicle-lite":{command:"node",args:[$kl,"serve","--data-dir",$dd,"--actor","agent-a"]}}}}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
  rm -rf "$P/.claude/cc-anchor/push"; hook session-start.sh SessionStart >/dev/null
  expect_deny "L2-04: server and actor read from \$CLAUDE_CONFIG_DIR/.claude.json" "git push"; unset CLAUDE_CONFIG_DIR; done_; fi
if run unavailable_first; then WRAP=1 MCPFILE=/dev/null setup; rm -rf "$P/.claude/cc-anchor/push"; touch "$W/broken"
  export SID=sess-0010-zzzz CC_ANCHOR_KRONICLE=1 CC_ANCHOR_KRONICLE_DATA_DIR=$DD
  o=$(pulse "git push"); o2=$(pulse "make")
  [[ "$o" != *'"deny"'* && "$o" == *"WITHOUT a check"* && "$o2" != *"WITHOUT a check"* ]] && ok "L2-03: never answered: allowed, and told once that it ran unchecked" || bad "unavailable first: ${o:0:160} / ${o2:0:80}"
  unset CC_ANCHOR_KRONICLE CC_ANCHOR_KRONICLE_DATA_DIR; export SID=sess-0001-aaaa; done_; fi

echo; echo "gate: pass=$pass fail=$fail"; exit $(( fail > 0 ))
