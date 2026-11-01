# cc-anchor — THE card renderer (single implementation, shared by every hook,
# the statusline and the CLI via lib.sh::cc_render).
#
# Invoked as:
#   jq -r -f render.jq \
#      --rawfile card    <anchor.md or /dev/null> \
#      --rawfile trail   <trail.jsonl>               (or /dev/null) \
#      --slurpfile state <state.json>               (or /dev/null => []) \
#      --rawfile c0 … --rawfile c3 <cursor candidate files or /dev/null> \
#      --arg now <iso> --arg name <project basename> --arg n <N> --arg root <abs root> \
#      --arg marker <marker line> --arg version <version comment line> \
#      --arg cursor_re <regex> \
#      < <hook JSON on stdin, or "null">
#
# stdin: a PostToolUse payload => a new breadcrumb is derived and appended;
#        anything else (null, {}) => render only.
#
# Output (raw text), four parts separated by newlines:
#   line 1  new trail entry as compact JSON, or empty
#   line 2  cursor captured from a get_system_state tool_response, or empty
#   line 3  updated state.json as compact JSON
#   rest    the full card text
#
# The caller appends line 1 to trail.jsonl, stores line 2 in <run>/cursor,
# writes line 3 to state.json and the rest to anchor.md.

def clip: tostring | gsub("[\\r\\n\\t]+"; " ") | .[0:96];

# Deterministic small hash of the hand-edited top (change detection only).
def h: explode | reduce .[] as $c (7; ((. * 31 + $c) % 1000000007));

def top_lines:
  ($card | split("\n")) as $l
  | ($l | index($marker)) as $mi
  | if $card == "" then
      [ "# ANCHOR — \($name)", $version,
        "Project: (unset — /cc-anchor:anchor set project \"one line\")",
        "Goal: (unset — /cc-anchor:anchor set goal \"what we are doing right now\")",
        "Invariants:",
        "- (none — /cc-anchor:anchor add-invariant \"never …\")" ]
    elif $mi == null then ($l | if .[-1] == "" then .[:-1] else . end)
    else $l[:$mi] end;

def cursor_from($raw):
  if $raw == "" then ""
  elif ($raw | ltrimstr(" ") | startswith("{")) then
    (try ($raw | fromjson | (.cursor_token // .cursor_compact // .cursor // "")) catch "")
  else ($raw | split("\n")[0] | gsub("\\s"; "")) end
  | if type == "string" and test($cursor_re) then . else "" end;

def entry:
  if (type == "object" and .hook_event_name == "PostToolUse" and (.tool_name|type) == "string") then
    { ts: $now,
      tool: .tool_name,
      target: ( .tool_input as $i
                | ( $i.file_path // $i.notebook_path // $i.path // $i.command // $i.url
                    // $i.pattern // $i.skill // $i.description // $i.query // $i.prompt // "" )
                | tostring
                | if $root != "" and startswith($root + "/") then .[($root | length) + 1:] else . end
                | clip ),
      session: (.session_id // "") }
  else null end;

def captured:
  if (type == "object" and (.tool_name // "" | test("^mcp__.*__get_system_state$"))) then
    ( [ .tool_response | .. | strings ] | join(" ")
      | ( [ match("sxt1c\\.[A-Za-z0-9_.-]+"; "g").string ][0]
          // [ match("sxt1\\.[A-Za-z0-9_.-]+"; "g").string ][0]
          // "" ) )
  else "" end;

. as $in
| ($state[0] // {}) as $st
| (entry) as $e
| (captured) as $cap
| (top_lines) as $top
| ($top | join("\n") | h | tostring) as $hash
| ( if $hash != ($st.top_hash // null) and (($st.top_hash // null) != null or $card != "")
    then $now else ($st.refreshed_at // null) end ) as $refreshed
| ( [ $cap, cursor_from($c0), cursor_from($c1), cursor_from($c2), cursor_from($c3) ]
    | map(select(. != "")) | .[0] // "" ) as $cursor
| ( ($trail | split("\n") | map(select(. != "")) | map(try fromjson catch empty))
    + (if $e == null then [] else [$e] end) ) as $entries
| (($st.instructions_files // "") | if . == "" then "" else "Instructions: \(.) (loaded \($st.instructions_loaded_at // "?"), \($st.instructions_reason // "?"))" end) as $instr
| (4 + (if $cursor != "" then 1 else 0 end) + (if $instr != "" then 1 else 0 end)) as $fixed
| ([ ($n | tonumber), (25 - ($top | length) - $fixed) ] | min | if . < 1 then 1 else . end) as $take
| ($entries | .[-$take:] | reverse) as $shown
| ($st + { top_hash: $hash, refreshed_at: $refreshed }) as $state2
| [ (if $e == null then "" else ($e | tojson) end),
    $cap,
    ($state2 | tojson),
    ( $top
      + [ $marker, "Trail (last \($take) tool calls, newest first):" ]
      + ( if ($shown | length) == 0 then ["- (no tool calls recorded yet)"]
          else ($shown | map("- \(.ts) \(.tool)" + (if .target == "" then "" else " \(.target)" end))) end )
      + ( if $cursor != "" then ["Cursor: \($cursor)"] else [] end )
      + ( if $instr != "" then [$instr] else [] end )
      + [ "Compacted: \($st.compacted_at // "never")",
          "Refreshed: \($refreshed // "never")" ]
      | join("\n") )
  ] | join("\n")
