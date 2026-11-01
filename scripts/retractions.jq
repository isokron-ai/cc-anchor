# cc-anchor — turn a `kronicle-lite orient --focus retractions --json` result
# into the compact lines the push (PostToolUse) and the pulse (PreToolUse)
# show the agent. One renderer for both, like render.jq for the card.
#
# Input: the orient JSON (kronicle-lite >= 0.5.0: retractions[] carry
#        doc_slug, heading_path, old_text, new_text, diff, severity, kind).
# Args:  $show_cosmetic "1" to list cosmetic retractions too.
# Output (raw, line-oriented; lib.sh splits it with bash builtins):
#   line 1  full cursor to persist ("" when the result has none)
#   line 2  head seq
#   line 3  "<shown> <blocking> <cosmetic>" counts
#   line 4  "ok", or "fail\x1f<seq>\x1f<problem>" when the briefing reports
#           integrity.ok === false (a corrupt or tampered store)
#   line 5… one "- …" line per shown retraction (at most 6, then "- … and N more")
#
# Cosmetic vs semantic: kronicle-lite may mark a retraction cosmetic
# (`cosmetic: true`, `change_class|materiality|class: "cosmetic"`, or
# `semantic: false`). When it does not, every retraction counts as semantic:
# the hook degrades to the 0.5.0/0.6.0 behaviour (push everything).
# Blocking (for the pulse) = semantic AND severity safety|behavioral.

def clip($n): if . == null then null else tostring | gsub("\\s+"; " ") | if length > $n then .[0:$n - 1] + "…" else . end end;
def cosmetic:
  (.cosmetic == true)
  or (.semantic == false)
  or (((.change_class // .materiality // .class // "") | tostring | ascii_downcase) == "cosmetic");
def blocking: (cosmetic | not) and ((.severity // "behavioral") | IN("safety", "behavioral"));
def where: [(.doc_slug // empty), ((.heading_path // []) | map(tostring) | join(" › ") | select(. != ""))] | join(" › ");
def line:
  "- " + (where | if . == "" then "" else . + " " end)
  + "(seq \(.seq // "?"), \(.kind // "?")/\(.severity // "?")\(if cosmetic then ", cosmetic" else "" end)): "
  + (if .old_text != null then
       "relied on \"\(.old_text | clip(140))\" → "
       + (if .new_text == null then "now REMOVED" else "now \"\(.new_text | clip(140))\"" end)
       + (if .diff != null then "; diff: \(.diff | clip(240))" else "" end)
     else (.reason_line // .event_type // "changed") | clip(300) end);

(.retractions // []) as $all
| ($all | map(select(cosmetic | not))) as $sem
| ($all | map(select(cosmetic))) as $cos
| (if $show_cosmetic == "1" then $all else $sem end) as $shown
| (.cursor // ""), ((.head.seq // "") | tostring),
  "\($shown | length) \($all | map(select(blocking)) | length) \($cos | length)",
  (if (.integrity | type) == "object" and .integrity.ok == false
   then "fail\u001f\(.integrity.seq // .integrity.at_seq // .integrity.first_bad_seq // "?")\u001f\(.integrity.problem // .integrity.error // "integrity check failed" | clip(240))"
   else "ok" end),
  ($shown[0:6][] | line),
  (if ($shown | length) > 6 then "- … and \(($shown | length) - 6) more (get_system_state with your cursor lists them all)" else empty end)
