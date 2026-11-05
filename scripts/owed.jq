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
#          "B\t<key>\x1f<actor>\x1f<read block>\x1f<item>" re-read by a plain
#          `kronicle-lite get` — cleared only once kronicle-lite confirms it,
#          "F\t<block id>" the version it had read (no longer relied on),
#          "R\t<block id | doc:slug>" read: what this result shows it read.
#          Evidence must come from kronicle-lite itself (see the mode).
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
      new: (.new_text | mkey), old: (.old_text | mkey), line: pline }
    + (if (.current.content_hash // null) != null then { ch: .current.content_hash } else {} end);

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
  # Evidence is a tool result PRODUCED BY kronicle-lite, never text that
  # merely looks like one (0.5.3, PR #6 review):
  #   * a kronicle-lite MCP tool (mcp__<…kronicle…>__*) or a kronicle://
  #     resource read: block objects in its result (block_id, content and,
  #     when both sides have one, the same content_hash);
  #   * a Bash call that is ONE plain `kronicle-lite get <slug>` /
  #     `get --block <id>` (no pipe, redirect, chaining, substitution or
  #     quoting), that succeeded (no stderr, not interrupted, stdout
  #     present): its stdout is the whole document (or block). Shell
  #     output alone proves nothing, so these come out as "B" lines: lib.sh
  #     asks kronicle-lite (`pending --actor`, read-only) whether it
  #     recorded that read at the current version (content hash), and only
  #     then clears them.
  # echo / grep / `| head` / an erroring get / a command that only mentions
  # the document show nothing.
  def expand: if type == "string" and test("^\\s*[\\[{]") then (fromjson? // .) else . end;
  def pct: [scan("%[0-9A-Fa-f]{2}|.")] | map(if startswith("%") and length == 3 then ([.[1:] | ascii_downcase | explode[] | if . >= 97 then . - 87 else . - 48 end] | .[0] * 16 + .[1] | [.] | implode) else . end) | join("");
  ($ARGS.named.owed // "" | items_of) as $items
  | (.tool_name // "" | tostring) as $tool
  | ($tool | test("^mcp__.*kronicle.*__"; "i")) as $klmcp
  | (($tool | test("ReadMcpResource|read_resource"; "i")) and ((.tool_input.uri // "") | tostring | startswith("kronicle://"))) as $klres
  | [ if $klmcp or $klres then (.tool_response | .. | expand | .. | expand) else empty end ] as $all
  | [ $all[] | objects | select((.block_id | type) == "string") ] as $objs
  | [ $all[] | strings ] as $strs
  | ($klmcp and ($tool | test("__(put_document|supersede_block|tombstone_block)$"))) as $write
  | ( if $klres then ((.tool_input.uri // "") | tostring | capture("^kronicle://docs/(?<s>[^?#]+)")? | .s | pct) // null else null end ) as $resdoc
  | (if $klres then ($strs | map(norm) | join(" \n ")) else "" end) as $restext
  # one plain, successful `kronicle-lite get` in Bash
  | (.tool_input.command // "" | tostring) as $cmd
  | ( if $tool == "Bash"
         and ($cmd | test("^\\s*(?:kronicle-lite|npx\\s+(?:-y\\s+)?kronicle-lite(?:@[A-Za-z0-9._-]+)?|node\\s+[A-Za-z0-9._/@~-]*cli\\.m?js)\\s+get(?:\\s+[A-Za-z0-9._:/@=,~+-]+)+\\s*$"))
         and ((.tool_response | type) == "object")
         and ((.tool_response.stderr // "") == "") and (.tool_response.interrupted != true)
         and ((.tool_response.stdout | type) == "string") and ((.tool_response.stdout | length) > 0)
      then
        ([ $cmd | splits("\\s+") | select(length > 0) ] | .[(index("get") + 1):]) as $a
        | (reduce range(0; $a | length) as $i ({skip: false, slug: null, block: null, json: false, actor: null};
             $a[$i] as $t
             | if .skip then .skip = false
               elif $t == "--block" then .block = ($a[$i + 1] // null) | .skip = true
               elif ($t | startswith("--block=")) then .block = ($t | ltrimstr("--block="))
               elif $t == "--actor" then .actor = ($a[$i + 1] // null) | .skip = true
               elif ($t | startswith("--actor=")) then .actor = ($t | ltrimstr("--actor="))
               elif ($t | IN("--data-dir", "--cwd")) then .skip = true
               elif $t == "--json" then .json = true
               elif ($t | startswith("-")) then .
               elif .slug == null then .slug = $t
               else . end)) as $g
        | .tool_response.stdout as $out
        | (if $g.json then ($out | fromjson? // null) else null end) as $j
        | if $g.block != null then
            { block: $g.block, actor: $g.actor,
              text: (if $g.json then ($j.content // "" | tostring) else $out end | norm),
              hash: (if $g.json then ($j.content_hash // null) else null end),
              id: (if $g.json then ($j.block_id // null) else $g.block end) }
          elif $g.slug != null then
            { slug: $g.slug, actor: $g.actor, text: (if $g.json then ($j.markdown // "" | tostring) else $out end | norm) }
          else null end
      else null end ) as $get
  | def hashok($o; $ch): ($ch == null) or (($o.content_hash // null) == null) or ($o.content_hash == $ch);
    def seen($id; $ch): any($objs[]; .block_id == $id and ((.content | type) == "string") and ((.status // "live") != "superseded") and hashok(.; $ch));
    def holds($slug; $t): any($objs[]; .doc_slug == $slug and ((.content | type) == "string") and ((.status // "live") == "live") and (.content | norm | contains($t)));
    # MCP / resource evidence: cleared at once
    def direct:
      .new as $new | .old as $old | (.ch // null) as $ch
      | if .cur != null then
          seen(.cur; $ch)
          or ($write and (.cur | IN($strs[])))
          or ($new != "" and (($resdoc == .slug and ($restext | contains($new))) or holds(.slug; $new)))
        else
          ($resdoc == .slug and $restext != "" and $old != "" and (($restext | contains($old)) | not))
          or (.tb as $tb | $tb != null and any($objs[]; .block_id == $tb and .status == "tombstoned"))
          or ($write and .tb != null and (.tb | IN($strs[])))
        end;
    # a plain get in Bash: cleared only once kronicle-lite confirms the read
    def viaget:
      $get != null and (
        .new as $new | .old as $old | (.ch // null) as $ch
        | if $get.block != null then
            .cur != null and $get.block == .cur and ($get.id == .cur)
            and ($get.hash == null or $ch == null or $get.hash == $ch)
            and $new != "" and ($get.text | contains($new))
          elif $get.slug == .slug then
            if .cur != null then $new != "" and ($get.text | contains($new))
            else $old != "" and (($get.text | contains($old)) | not) end
          else false end );
  # one tagged line each: O <owed item>, C <cleared key>, F <block no longer
  # relied on>, R <read>, B <key>␟<actor>␟<read block>␟<item> (\x1f-separated;
  # needs kronicle-lite's confirmation)
  ( $items[] | if direct then "C\t\(.k)", (.rd // empty | "F\t\(.)")
               elif viaget then "B\t" + ([.k, ($get.actor // ""), (.rd // ""), tojson] | join("\u001f"))
               else "O\t\(tojson)" end ),
  ( [ $objs[] | select((.content | type) == "string") | .block_id ]
    + (if $resdoc != null and $restext != "" then ["doc:" + $resdoc] else [] end)
    + (if $get != null and $get.slug != null then ["doc:" + $get.slug] elif $get != null then [$get.block] else [] end)
    + (if $write then [ $strs[] | select(test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) ] else [] end)
    | unique[] | "R\t\(.)" )

elif $mode == "merge" then
  ($ARGS.named.done // "" | lines_of) as $done
  | $ARGS.named.owed // "" | items_of | unique_by(.k) | .[] | select((.k | IN($done[])) | not) | tojson
else empty end
