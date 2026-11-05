# cc-anchor — the per-agent reconciliation ledger (0.5.2, L2-05).
#
# kronicle-lite's `pending` is per ACTOR, and one Claude Code session usually
# reads as ONE actor (the MCP server's --actor) from the main agent and every
# subagent. One agent's re-read therefore cleared the gate for all of them,
# and a subagent started after the coordinator had taken the push got neither
# the push nor a deny. cc-anchor now keeps, per agent_id, the changes that
# agent still owes a re-read of (<B>.owed), the keys it has re-read (<B>.done)
# and the kronicle-lite blocks / documents it was observed reading (<B>.reads).
# lib.sh (cc_kl_ledger_*) owns the files; this file owns the logic.
#
# Ledger item (one compact JSON object per line of <B>.owed):
#   k     identity: "c:<current block id>" (a live change) or
#         "t:<block id>:<seq>" (a removal)
#   slug  document slug;  seq  chain seq of the change
#   cur   block id of the CURRENT version (null once removed)
#   tb    the removed block (removals)
#   rd    the block version that was read (when known)
#   new   current text, whitespace-normalised, at most 100 chars (matching)
#   old   the text read, same form (a removal is re-read when it is gone)
#   line  the "- …" line the gate shows
#
# Modes ($mode):
#   fmt    input: orient / `pending --json` output. The pending text the gate
#          shows (header "count\x1fhidden\x1factor\x1fslugs", then "- …"
#          lines, at most 6), or "nocap" when there is no pending_count
#          (kronicle-lite <= 0.7.0).
#   feed   input: the same. One compact JSON {p:[items], r:[steps]}: p = the
#          pending items as ledger items; r = the chain's retractions and
#          format-only edits as lineage steps {from, to, block: bool, item}.
#   reg    -n; $owed $done $reads (raw file contents) and $feed (a feed
#          JSON): the agent's updated owed lines. Steps first (in seq order):
#          an owed item whose current block was superseded or removed is
#          replaced by the newer change; a blocking retraction of a block or
#          document the agent was observed reading becomes owed. Then the
#          pending items not yet owed or re-read by this agent are added (a
#          newer change of the same lineage replaces the older one).
#   clear  input: a PostToolUse payload; $owed (raw). Tab-tagged lines:
#          "O\t<item>" still owed, "C\t<key>" re-read (cleared),
#          "F\t<block id>" the version it had read (no longer relied on),
#          "R\t<block id | doc:slug>" read: what this result shows it read.
#          Evidence is content the agent was shown, never a count:
#            - a block (recall hit, `get --block --json`) whose block_id is
#              the current version, or a live block of the document whose
#              text holds the current text;
#            - a whole-document read (ReadMcpResourceTool
#              kronicle://docs/<slug>, Bash `kronicle-lite get <slug>`)
#              holding the current text, or, for a removal, no longer holding
#              the removed text;
#            - the agent's own write (put_document / supersede_block /
#              tombstone_block result naming the current block).
#          A tool result that only TALKS about the change (the push,
#          get_system_state, `pending`) shows no block content: no evidence.
#   merge  -n; $owed (raw, possibly several ledgers concatenated) and $done:
#          the owed lines deduplicated by key, minus keys in $done (a
#          subagent inheriting what the session's agents still owe).

def clip($n): if . == null then null else tostring | gsub("\\s+"; " ") | if length > $n then .[0:$n - 1] + "…" else . end end;
def norm: tostring | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ");
# Matching form of a (possibly clipped) snippet.
def mkey: if . == null then "" else norm | rtrimstr("…") | rtrimstr(" ") | .[0:100] end;
def where: [(.doc_slug // empty), ((.heading_path // []) | map(tostring) | join(" › ") | select(. != ""))] | join(" › ");

# The pending line (kronicle-lite >= 0.8.0 `pending[]` item). The gate
# compares owed lines with these, so both come from here.
def pline:
  "- " + where
  + " (seq \(.seq // "?"), \(.change // .kind // "?")/\(.severity // "?")"
  + (if (.read.head_seq // null) != null then "; you read it at seq \(.read.head_seq)" else "" end) + ")"
  + ": read \"\(.old_text // "?" | clip(120))\" → "
  + (if .current == null then "now REMOVED" else "now \"\(.new_text // "?" | clip(120))\"" end)
  + (if .diff != null then "; diff: \(.diff | clip(200))" else "" end)
  + (if (.derived_notes // []) | length > 0 then "; your notes derived from it: \((.derived_notes | map(if type == "object" then (.doc_slug // .slug // .block_id // "?") else tostring end) | join(", ")) | clip(120))" else "" end)
  + (if .resolve != null then " — \(.resolve | clip(160))" else "" end);

# The retraction line (same text as scripts/retractions.jq).
def cosmetic:
  (.cosmetic == true)
  or (.semantic == false)
  or (((.change_class // .materiality // .class // "") | tostring | ascii_downcase) == "cosmetic");
def blocking: (cosmetic | not) and ((.severity // "behavioral") | IN("safety", "behavioral"));
def rline:
  "- " + (where | if . == "" then "" else . + " " end)
  + "(seq \(.seq // "?"), \(.kind // "?")/\(.severity // "?")): "
  + (if .old_text != null then
       "relied on \"\(.old_text | clip(140))\" → "
       + (if .new_text == null then "now REMOVED" else "now \"\(.new_text | clip(140))\"" end)
       + (if .diff != null then "; diff: \(.diff | clip(240))" else "" end)
     else (.reason_line // .event_type // "changed") | clip(300) end);

def pitem:
  (.current.block_id // null) as $cur
  | (.read.block_id // null) as $rd
  | select(.doc_slug != null and ($cur != null or $rd != null))
  | { k: (if $cur != null then "c:\($cur)" else "t:\($rd):\(.seq // "?")" end),
      slug: .doc_slug, seq: .seq, cur: $cur, tb: (if $cur == null then $rd else null end), rd: $rd,
      new: (.new_text | mkey), old: (.old_text | mkey), line: pline };

def ritem:
  { k: (if .successor_block_id != null then "c:\(.successor_block_id)" else "t:\(.block_id):\(.seq // "?")" end),
    slug: .doc_slug, seq: .seq, cur: .successor_block_id,
    tb: (if .successor_block_id == null then .block_id else null end), rd: .block_id,
    new: (.new_text | mkey), old: (.old_text | mkey), line: rline };

def lines_of: if . == null then [] else split("\n") | map(select(length > 0)) end;
def items_of: lines_of | map(fromjson? // empty | select(type == "object" and (.k | type) == "string"));

if $mode == "fmt" then
  if (.pending_count | type) != "number" then "nocap" else
    "\(.pending_count)\u001f\(.pending_hidden // 0)\u001f\(.pending_actor // .actor_id // "")\u001f\([(.pending // [])[] | .doc_slug // empty] | unique | join(", "))",
    ((.pending // [])[0:6][] | pline),
    (if (.pending_count // 0) > 6 then "- … and \(.pending_count - 6) more (kronicle-lite pending --actor \(.pending_actor // .actor_id // "?"))" else empty end)
  end

elif $mode == "feed" then
  { p: [ (.pending // [])[] | pitem ],
    r: ( [ (.retractions // [])[] | select(.block_id != null) | {seq: (.seq // 0), from: .block_id, to: .successor_block_id, block: blocking, slug: .doc_slug, item: ritem} ]
       + [ ((.format_only_edits // []) + (.cosmetic_edits // []))[] | select(.block_id != null and .successor_block_id != null)
           | {seq: (.seq // 0), from: .block_id, to: .successor_block_id, block: false, slug: .doc_slug, item: null} ]
       | sort_by(.seq) ) }
  | tojson

elif $mode == "reg" then
  ($ARGS.named.done // "" | lines_of) as $done
  | ($ARGS.named.reads // "" | lines_of) as $reads
  | ($ARGS.named.feed // "{}" | fromjson) as $f
  # lineage steps, oldest first
  | reduce ($f.r // [])[] as $s ($ARGS.named.owed // "" | items_of;
      if any(.[]; .cur == $s.from) then
        if $s.block then [ .[] | select(.cur != $s.from) ] + (if ($s.item.k | IN($done[])) then [] else [$s.item] end)
        else map(if .cur == $s.from then                                                 # format-only twin / cosmetic edit
                   .cur = $s.to | (if $s.to == null then .tb = $s.from else . end)
                   | (if $s.item != null and $s.item.new != "" then .new = $s.item.new else . end)
                 else . end) end
      elif $s.block and $s.item != null
           and (($s.from | IN($reads[])) or (("doc:" + ($s.slug // "")) | IN($reads[])))
           and (($s.item.k | IN($done[])) | not) then
        . + [$s.item]
      else . end
      | unique_by(.k))
  # pending items not yet owed or re-read; a newer change of a lineage replaces the older one
  | reduce ($f.p // [])[] as $n (.;
      if any(.[]; .k == $n.k) then .
      else [ .[] | select(($n.rd == null or (.cur != $n.rd and .rd != $n.rd)) and ($n.cur == null or .cur != $n.cur)) ]
           + (if ($n.k | IN($done[])) then [] else [$n] end) end)
  | .[] | tojson

elif $mode == "clear" then
  def expand: if type == "string" and test("^\\s*[\\[{]") then (fromjson? // .) else . end;
  def pct: [scan("%[0-9A-Fa-f]{2}|.")] | map(if startswith("%") and length == 3 then ([.[1:] | ascii_downcase | explode[] | if . >= 97 then . - 87 else . - 48 end] | .[0] * 16 + .[1] | [.] | implode) else . end) | join("");
  ($ARGS.named.owed // "" | items_of) as $items
  | [ .tool_response | .. | expand | .. | expand ] as $all
  | [ $all[] | objects | select((.block_id | type) == "string") ] as $objs
  | [ $all[] | strings ] as $strs
  | ($strs | map(norm) | join(" \n ")) as $text
  | (.tool_name // "") as $tool
  | ($tool | test("__(put_document|supersede_block|tombstone_block)$")) as $write
  # a whole-document read: the MCP resource, or `kronicle-lite get <slug>` in Bash
  | ( if ($tool | test("ReadMcpResource|read_resource"; "i")) then
        ((.tool_input.uri // "") | tostring | capture("^kronicle://docs/(?<s>[^?#]+)")? | .s | pct) // null
      elif $tool == "Bash" then
        ((.tool_input.command // "") | tostring
         | [ scan("(?:kronicle-lite|cli\\.m?js)[\"']?\\s+get((?:\\s+[^\\s|;&<>()]+)*)") | .[0] ]
         | map( [ splits("\\s+") | select(length > 0) | gsub("^[\"']|[\"']$"; "") ]
                | if any(.[]; . == "--block" or startswith("--block=")) then null
                  else (reduce .[] as $t ({skip: false, slug: null};
                          if .slug != null then .
                          elif .skip then .skip = false
                          elif ($t | IN("--actor", "--data-dir", "--cwd")) then .skip = true
                          elif ($t | startswith("-")) then .
                          else .slug = $t end) | .slug) end )
         | map(select(. != null)) | first) // null
      else null end ) as $doc
  | ($doc != null and ($text | length) > 0) as $docread
  | def seen($id): any($objs[]; .block_id == $id and ((.content | type) == "string") and ((.status // "live") != "superseded"));
    def holds($slug; $t): any($objs[]; .doc_slug == $slug and ((.content | type) == "string") and ((.status // "live") == "live") and (.content | norm | contains($t)));
    def reread:
      .new as $new | .old as $old
      | if .cur != null then
        seen(.cur)
        or ($write and (.cur | IN($strs[])))
        or ($new != "" and (($docread and $doc == .slug and ($text | contains($new))) or holds(.slug; $new)))
      else
        ($docread and $doc == .slug and $old != "" and (($text | contains($old)) | not))
        or (.tb as $tb | $tb != null and any($objs[]; .block_id == $tb and .status == "tombstoned"))
        or ($write and .tb != null and (.tb | IN($strs[])))
      end;
  # one tagged line each: O <owed item>, C <cleared key>, F <block no longer relied on>, R <read>
  ( $items[] | if reread then "C\t\(.k)", (.rd // empty | "F\t\(.)") else "O\t\(tojson)" end ),
  ( [ $objs[] | select((.content | type) == "string") | .block_id ]
    + (if $docread then ["doc:" + $doc] else [] end)
    + (if $write then [ $strs[] | select(test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) ] else [] end)
    | unique[] | "R\t\(.)" )

elif $mode == "merge" then
  ($ARGS.named.done // "" | lines_of) as $done
  | $ARGS.named.owed // "" | items_of | unique_by(.k) | .[] | select((.k | IN($done[])) | not) | tojson
else empty end
