# cc-anchor — audit telemetry (benchmark accounting) from a Claude Code
# transcript chunk. Run as: jq -nc -R [args] -f telemetry.jq < <new lines>
#
# Claude Code hook payloads carry no token usage; the transcript does. Each
# assistant entry has message.usage exactly as the provider returned it
# (input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
# output_tokens). One API response is written as several entries (one per
# content block), all with the same message.id and usage: counted ONCE, the
# last entry wins. Nothing is added to or derived into the provider's counts.
#
# Records (one compact JSON object per line, schema "cca.telemetry/1"):
#   model_call  one per API response: request_id, message_id, model, the four
#               usage counts as reported, at (transcript timestamp). A count
#               that is not a non-negative integer is null and named in
#               invalid_usage (never coerced to 0).
#   tool_call   one per tool result: tool, tool_use_id, input_bytes,
#               result_bytes, images, is_error, latency_ms (tool_result
#               timestamp − tool_use timestamp, as written to the transcript:
#               includes hook time), tool_response_tokens_est + est_method
#               "bytes/4". The estimate is NOT part of any input count: the
#               provider's input/cache counts already include tool results.
#   compaction  one per compact_boundary: trigger, pre_tokens, post_tokens,
#               duration_ms (as Claude Code reports them).
#   turn_usage  (when this chunk had any of the above) the sums of this
#               chunk's valid model_call counts, api_calls,
#               invalid_usage_calls (when any), models, tool_calls,
#               tool_result_bytes, tool_response_tokens_est; closed_by = the
#               hook event that flushed it. sum(turn_usage) == sum(model_call).
#
# Exactly once: $seen (--rawfile, one key per line: m:<message id>,
# t:<tool_use_id>, c:<compaction>) holds what earlier chunks counted; those
# are skipped, so an API response whose content-block entries straddle two
# chunks, or a transcript read again after a rewrite, is not counted twice.
# $open (--rawfile) carries tool uses whose result is in a later chunk.
# With $internal "1" (the hook) two kinds of raw lines follow the records:
# "#seen\t<key>" and "#open\t<tool use>"; telemetry.sh keeps them out of
# the telemetry file.
#
# No content is ever copied: only names, ids, counts and timestamps. The one
# free-text field, the tool name (an MCP server picks it), goes through
# `redact` (defence in depth; regexes on every field would cost 4x).
#
# Args: $sid $agent ("" = main agent) $observer $tx (transcript basename)
#       $ev (hook event or "scan") $now; $fmt "cca" (default) or "kronicle";
#       $internal; --rawfile seen / open.

def redact:
  gsub("(?<k>sk-(ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+"; "\(.k)…[REDACTED]")
  | gsub("(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}"; "[REDACTED]")
  | gsub("xox[abposr]-[A-Za-z0-9-]{10,}"; "[REDACTED]")
  | gsub("AKIA[0-9A-Z]{16}"; "[REDACTED]")
  | gsub("(?i)(bearer|token|api[_-]?key|secret|password)(?<s>[\"' :=]+)[A-Za-z0-9._~+/=-]{12,}"; "\(.s)[REDACTED]")
  | gsub("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"; "[REDACTED]");

def tsms:
  if type == "string" then
    (capture("^(?<b>[0-9T:-]+)(\\.(?<f>[0-9]+))?Z$")
     | ((.b + "Z") | fromdateiso8601) * 1000 + (((.f // "0") + "00")[0:3] | tonumber)) // null
  else null end;

def bytes: if . == null then 0 elif type == "string" then utf8bytelength else tojson | utf8bytelength end;
# A usage count is accepted only as a non-negative integer below 1e15:
# anything else (negative, a string, a float, 1e400) is rejected and flagged,
# never coerced to 0.
def okn: type == "number" and . >= 0 and . < 1e15 and . == floor;
def lines_of: if type == "string" then split("\n") | map(select(length > 0)) else [] end;

# tool_result content: a string, or blocks (text / image / …)
def rbytes: if type == "array" then map(if (type == "object" and .type == "text") then (.text | bytes) elif (type == "object" and .type == "image") then 0 else bytes end) | add // 0 else bytes end;
def rimages: if type == "array" then map(select(type == "object" and .type == "image")) | length else 0 end;

($ARGS.named.fmt // "cca") as $fmt
| (($ARGS.named.internal // "1") == "1") as $internal
| ($ARGS.named.seen // "" | lines_of | map({ key: ., value: true }) | from_entries) as $seen
| { schema: "cca.telemetry/1", session_id: ($ARGS.named.sid // ""), agent_id: (($ARGS.named.agent // "") | if . == "" then null else . end),
    observer: ($ARGS.named.observer // ""), transcript: ($ARGS.named.tx // "") } as $base
| [ inputs | fromjson? | objects | select((.message // {}) | type == "object") ] as $e

| ( [ $e[] | select(.type == "assistant" and (.message.usage | type) == "object" and (.message.model // "") != "<synthetic>") ]
    | group_by(.message.id // .requestId // .uuid | tostring) | map(first)
    | map(("m:" + (.message.id // .requestId // .uuid | tostring)) as $k | select($seen[$k] | not)
      | .message.usage as $u
      | ([ "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens" ] | map(select(($u[.] // 0) | okn | not))) as $bad
      | { ev: "model_call", k: $k, at: .timestamp, request_id: .requestId, message_id: .message.id, model: .message.model,
          input_tokens: ($u.input_tokens // 0 | if okn then . else null end),
          cache_creation_input_tokens: ($u.cache_creation_input_tokens // 0 | if okn then . else null end),
          cache_read_input_tokens: ($u.cache_read_input_tokens // 0 | if okn then . else null end),
          output_tokens: ($u.output_tokens // 0 | if okn then . else null end) }
        + (if $bad == [] then {} else { invalid_usage: $bad } end))
    | sort_by(.at | tostring) ) as $calls
| ($calls | map(select(has("invalid_usage") | not))) as $valid

# tool uses: this chunk's, plus the ones a previous chunk left open
| ( [ ($ARGS.named.open // "" | lines_of[] | fromjson? | objects | select((.id | type) == "string")),
      ($e[] | select(.type == "assistant") | .timestamp as $t | (.message.content // [])
       | if type == "array" then .[] else empty end | objects | select(.type == "tool_use")
       | { id: (.id // "" | tostring), name: (.name // null | if type == "string" then . else tostring end), at: $t, input_bytes: (.input | bytes) }) ]
    | map({ key: .id, value: . }) | from_entries ) as $uses

| [ $e[] | select(.type == "user") | .timestamp as $t | (.message.content // [])
    | if type == "array" then .[] else empty end | objects | select(.type == "tool_result")
    | (.tool_use_id // "" | tostring) as $id
    | ("t:" + $id) as $k | select($seen[$k] | not)
    | ($uses[$id] // null) as $u
    | (.content | rbytes) as $rb
    | { ev: "tool_call", k: $k, at: $t, tool: ($u.name // null), tool_use_id: $id,
        input_bytes: ($u.input_bytes // null), result_bytes: $rb, images: (.content | rimages),
        is_error: (.is_error == true),
        latency_ms: (if $u == null then null else (($t | tsms) as $b | ($u.at | tsms) as $a | if $a != null and $b != null then $b - $a else null end) end),
        tool_response_tokens_est: (($rb + 3) / 4 | floor), est_method: "bytes/4" } ] as $tools

| ( [ $e[] | select(.type == "user") | (.message.content // []) | if type == "array" then .[] else empty end
      | objects | select(.type == "tool_result") | (.tool_use_id // "" | tostring) ] | map({ key: ., value: true }) | from_entries ) as $done
| [ $uses[] | select($done[.id] | not) ] as $still_open

| [ $e[] | select(.type == "system" and .subtype == "compact_boundary")
    | ("c:" + (.uuid // .timestamp | tostring)) as $k | select($seen[$k] | not)
    | { ev: "compaction", k: $k, at: .timestamp, trigger: (.compactMetadata.trigger // null),
        pre_tokens: (.compactMetadata.preTokens // null), post_tokens: (.compactMetadata.postTokens // null),
        duration_ms: (.compactMetadata.durationMs // null) } ] as $compacts

| ( if ($calls | length) + ($tools | length) + ($compacts | length) == 0 then []
    else [ { ev: "turn_usage", at: ($ARGS.named.now // null), closed_by: ($ARGS.named.ev // "scan"),
             api_calls: ($calls | length), models: ($calls | map(.model) | unique),
             input_tokens: ($valid | map(.input_tokens) | add // 0),
             cache_creation_input_tokens: ($valid | map(.cache_creation_input_tokens) | add // 0),
             cache_read_input_tokens: ($valid | map(.cache_read_input_tokens) | add // 0),
             output_tokens: ($valid | map(.output_tokens) | add // 0),
             tool_calls: ($tools | length), tool_result_bytes: ($tools | map(.result_bytes) | add // 0),
             tool_response_tokens_est: ($tools | map(.tool_response_tokens_est) | add // 0), est_method: "bytes/4",
             compactions: ($compacts | length) }
           + (if ($calls | length) > ($valid | length) then { invalid_usage_calls: (($calls | length) - ($valid | length)) } else {} end) ] end ) as $turn

| ( ($calls + $tools + $compacts | sort_by(.at | tostring)) + $turn
    | .[] | $base + del(.k)
    | (if (.tool | type) == "string" then .tool |= redact else . end)
    | if $fmt == "kronicle" then
        # Draft mapping onto kronicle-lite audit events (AUDIT_BUSINESS_PLAN §5);
        # field names follow cca.telemetry/1 until kronicle-lite's own schema lands.
        { schema: "kronicle.audit/0-draft", source: "cc-anchor", boundary: "model",
          event_type: ({ model_call: "model_call", tool_call: "call_measured", compaction: "compaction", turn_usage: "turn_usage" }[.ev] // .ev),
          fingerprint: null, at: .at, session_id: .session_id, agent_id: .agent_id, observer: .observer,
          payload: (del(.schema, .ev, .at, .session_id, .agent_id, .observer)
                    | if has("is_error") then .status = (if .is_error then "error" else "ok" end) else . end) }
      else . end ),
  # internal lines for telemetry.sh (never written to the telemetry file):
  # keys now counted (the seen-set) and tool uses still waiting for a result
  ( select($internal) | ($calls + $tools + $compacts)[] | "#seen\t\(.k)" ),
  ( select($internal) | $still_open | sort_by(.at | tostring) | .[-200:][] | "#open\t\(tojson)" )
