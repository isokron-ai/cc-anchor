#!/usr/bin/env bash
# cc-anchor — Cursor hooks adapter.
#
#   bash adapter.sh <cursorEvent>      (stdin: Cursor hook JSON; stdout: Cursor hook JSON)
#
# Cursor's hooks.json (https://cursor.com/docs/agent/hooks) speaks a
# different dialect from Claude Code's: no `source`, `cwd` only on tool
# events, `workspace_roots[]` instead of CLAUDE_PROJECT_DIR, `tool_output`
# as a JSON *string*, MCP tools named `MCP:<tool>`, stop/subagentStop
# answered with `followup_message` instead of `decision: "block"`, and
# sessionStart answered with `additional_context` (snake_case). This
# adapter rewrites each Cursor payload into the Claude Code shape the
# scripts in ../scripts already handle, runs the script, and rewrites the
# answer back. Field mapping (Cursor → Claude Code):
#
#   sessionStart   {session_id, is_background_agent}         → SessionStart{source:"startup"}
#                  out {hookSpecificOutput.additionalContext} → {additional_context}
#   preCompact     {trigger}                                  → PreCompact{trigger}     (no output)
#   postToolUse    {tool_name, tool_input, tool_output(str), cwd}
#                                                             → PostToolUse{tool_name, tool_input, tool_response(parsed)}
#                  "MCP:sea_claim" → "mcp__cursor__sea_claim" so the sea_* regex matches
#   afterFileEdit  {file_path, edits}                         → PostToolUse{tool_name:"Edit", tool_input:{file_path}}
#   preToolUse     {tool_name:"Write", tool_input:{path…}}    → PreToolUse{tool_name:"Edit", tool_input:{file_path}}
#                  out deny → {permission:"deny", agent_message, user_message}
#   stop           {status, loop_count}                       → Stop{stop_hook_active: loop_count>0, last_assistant_message:""}
#                  out {decision:"block", reason} → {followup_message: reason}
#                  (Cursor's stop input carries no assistant text, so the
#                  kronicle session document holds the card only.)
#   subagentStop   {subagent_type, status, summary, …}        → SubagentStop{agent_id:"", stop_hook_active: loop_count>0}
#                  NOTE: Cursor gives subagentStop no subagent id, so claims
#                  cannot be attributed to the stopping subagent; see README
#                  "Cursor → parity gaps".
#   beforeSubmitPrompt {prompt}                               → UserPromptSubmit{prompt}
#                  Cursor's output schema has no context field here, so the
#                  bare word `anchor` cannot inject; the adapter exits 0.
#
# Project root: $CLAUDE_PROJECT_DIR if set, else workspace_roots[0], else
# $PWD (Cursor runs project hooks from the project root).
set -u
HERE="${BASH_SOURCE[0]%/*}"; [[ "$HERE" == "${BASH_SOURCE[0]}" ]] && HERE=.
SCRIPTS="${CC_ANCHOR_SCRIPTS:-$HERE/../scripts}"
[[ -d "$SCRIPTS" ]] || SCRIPTS="$HERE/scripts"
command -v jq >/dev/null 2>&1 || exit 0
ev="${1:-}"
input="$(cat 2>/dev/null || true)"
[[ -n "$input" ]] || exit 0

root="${CLAUDE_PROJECT_DIR:-}"
[[ -n "$root" ]] || root="$(jq -r '.workspace_roots[0] // .cwd // empty' <<<"$input" 2>/dev/null)"
[[ -n "$root" ]] || root="$PWD"
export CLAUDE_PROJECT_DIR="$root"

run() { bash "$SCRIPTS/$1" <<<"$2" 2>/dev/null; }

case "$ev" in
  sessionStart)
    payload="$(jq -c --arg root "$root" '{hook_event_name:"SessionStart", source:"startup", session_id:(.session_id // .conversation_id // ""), cwd:$root, transcript_path:(.transcript_path // "")}' <<<"$input")"
    out="$(run session-start.sh "$payload")"
    [[ -n "$out" ]] && jq -c '{additional_context: (.hookSpecificOutput.additionalContext // "")} | select(.additional_context != "")' <<<"$out"
    ;;
  preCompact)
    payload="$(jq -c --arg root "$root" '{hook_event_name:"PreCompact", trigger:(.trigger // "auto"), custom_instructions:null, session_id:(.conversation_id // ""), cwd:$root}' <<<"$input")"
    run pre-compact.sh "$payload" >/dev/null
    ;;
  postToolUse)
    payload="$(jq -c --arg root "$root" '
      (.tool_name // "") as $tn
      | {hook_event_name:"PostToolUse",
         session_id:(.conversation_id // ""), cwd:(.cwd // $root),
         tool_name:(if ($tn | startswith("MCP:")) then "mcp__cursor__" + ($tn | ltrimstr("MCP:")) else $tn end),
         tool_input:(.tool_input // {}),
         tool_response:((.tool_output // "") | if type == "string" then (try fromjson catch .) else . end),
         tool_use_id:(.tool_use_id // "")}' <<<"$input")"
    run post-tool-use.sh "$payload" >/dev/null
    ;;
  afterFileEdit)
    payload="$(jq -c --arg root "$root" '{hook_event_name:"PostToolUse", session_id:(.conversation_id // ""), cwd:$root, tool_name:"Edit", tool_input:{file_path:(.file_path // "")}, tool_response:{}}' <<<"$input")"
    run post-tool-use.sh "$payload" >/dev/null
    ;;
  preToolUse)
    payload="$(jq -c --arg root "$root" '
      (.tool_input // {}) as $ti
      | {hook_event_name:"PreToolUse", session_id:(.conversation_id // ""), cwd:(.cwd // $root),
         tool_name:(if (.tool_name // "") == "Write" then "Edit" else (.tool_name // "") end),
         tool_input:{file_path:($ti.file_path // $ti.path // $ti.target_file // "")},
         tool_use_id:(.tool_use_id // "")}' <<<"$input")"
    [[ "$(jq -r '.tool_input.file_path' <<<"$payload")" != "" ]] || exit 0
    out="$(run pre-tool-use.sh "$payload")"
    if [[ -n "$out" ]] && [[ "$(jq -r '.hookSpecificOutput.permissionDecision // ""' <<<"$out")" == "deny" ]]; then
      jq -c '{permission:"deny", agent_message:(.hookSpecificOutput.permissionDecisionReason // ""), user_message:"cc-anchor scope guard denied this edit (sea-lite claim conflict)"}' <<<"$out"
    fi
    ;;
  stop)
    payload="$(jq -c --arg root "$root" '{hook_event_name:"Stop", session_id:(.conversation_id // ""), cwd:$root, stop_hook_active:((.loop_count // 0) > 0), last_assistant_message:"", background_tasks:[], session_crons:[]}' <<<"$input")"
    out="$(run stop.sh "$payload")"
    [[ -n "$out" ]] && jq -c 'if .decision == "block" then {followup_message: .reason} else empty end' <<<"$out"
    ;;
  subagentStop)
    payload="$(jq -c --arg root "$root" '{hook_event_name:"SubagentStop", session_id:(.conversation_id // ""), cwd:$root, stop_hook_active:((.loop_count // 0) > 0), agent_id:"", agent_type:(.subagent_type // ""), last_assistant_message:(.summary // "")}' <<<"$input")"
    out="$(run subagent-stop.sh "$payload")"
    [[ -n "$out" ]] && jq -c 'if .decision == "block" then {followup_message: .reason} else empty end' <<<"$out"
    ;;
  beforeSubmitPrompt)
    exit 0
    ;;
  *) exit 0;;
esac
exit 0
