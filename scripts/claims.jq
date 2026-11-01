# cc-anchor — sea-lite claim tracker (state machine, one jq call).
#
# Invoked by lib.sh::cc_claims_update ONLY when the PostToolUse tool name
# matches ^mcp__.*__sea_(claim|next|create|release|transition|refresh)$:
#
#   jq -c -f claims.jq --slurpfile claims <claims.json or /dev/null> \
#      --arg now <iso> --arg terminal_re <regex> < <PostToolUse payload>
#
# Input:  the PostToolUse payload. The MCP result is read from
#         tool_response (either {content:[{type:"text",text}]} or a bare
#         string/object); the first text that parses as JSON is the result.
# Output: the new claims.json  {claims:{<ticket_id>:{claim_token, expires,
#         agent, session, cwd, taken, via}}}
#
# Transitions (sea-lite 0.1.x result shapes, src/handlers/{claims,tickets}.ts):
#   sea_claim      {claims:[{ticket_id, claim_token, expires_at}]}  → add each
#   sea_next       {ticket:{id}|null, claim_token, expires_at}     → add when ticket != null
#   sea_create     {ticket:{id}, claim_token|null, claim_expires_at} → add when claim_token != null
#   sea_refresh    {expires_at} (holder-only)                        → bump expires for tool_input.ticket_id
#   sea_release    tool_input.ticket_id                              → drop (prefix match: ids may be ≥8-char prefixes)
#   sea_transition tool_input.to ∈ terminal                          → drop (terminal states release the claim)
#   any result with an `error` key                                   → no change
# Expired entries (expires <= now) are dropped on every update.

def result:
  [ .tool_response
    | if type == "string" then . elif type == "object" and has("content") then (.content[]? | select(.type == "text") | .text) else tojson end
  ] | map(select(type == "string") | try fromjson catch empty) | map(select(type == "object")) | .[0] // {};

def short_tool: .tool_name | sub("^mcp__.*__"; "");

def agent: (.agent_id // "");
def session: (.session_id // "");

. as $in
| ($in | result) as $r
| ($in | agent) as $a
| ($in | session) as $s
| ($in | short_tool) as $t
| (($claims[0] // {}) | .claims //= {}) as $st
| def add($id; $tok; $exp; $via):
    if ($id | type) == "string" and $id != "" and ($tok | type) == "string" and $tok != "" then
      .claims[$id] = { claim_token: $tok, expires: ($exp // "9999-12-31T23:59:59Z"), agent: $a, session: $s, cwd: ($in.cwd // ""), taken: $now, via: $via }
    else . end;
  def drop_prefix($p):
    if ($p | type) == "string" and $p != "" then .claims |= with_entries(select(.key | startswith($p) | not)) else . end;
  $st
| if ($r | has("error")) then .
  elif $t == "sea_claim" then
    reduce ($r.claims // [])[] as $c (.; add($c.ticket_id; $c.claim_token; $c.expires_at; "sea_claim"))
  elif $t == "sea_next" then
    if ($r.ticket // null) != null then add($r.ticket.id; $r.claim_token; $r.expires_at; "sea_next") else . end
  elif $t == "sea_create" then
    if ($r.claim_token // null) != null then add($r.ticket.id; $r.claim_token; $r.claim_expires_at; "sea_create") else . end
  elif $t == "sea_refresh" then
    (($in.tool_input.ticket_id // "") as $p
      | if $p != "" and ($r.expires_at // null) != null then
          .claims |= with_entries(if (.key | startswith($p)) then .value.expires = $r.expires_at else . end)
        else . end)
  elif $t == "sea_release" then drop_prefix($in.tool_input.ticket_id // "")
  elif $t == "sea_transition" then
    if (($in.tool_input.to // "") | test($terminal_re)) then drop_prefix($in.tool_input.ticket_id // "") else . end
  else . end
| .claims |= with_entries(select(.value.expires > $now))
