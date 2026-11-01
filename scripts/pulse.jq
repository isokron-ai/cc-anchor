# cc-anchor — Bash command analysis for the PreToolUse pulse (scripts/pulse.sh).
#
# Input: the PreToolUse hook payload (.tool_input.command).
# Args:  $match  world-changing regex (config `pulse_match`); word boundaries
#                are added here, so `deploy` matches `./bin/deploy --x` and
#                `make deploy` but not `deployment.yaml` or `predeploy`.
# Output (one compact JSON line):
#   { world: [<segment>…]   segments that run a world-changing command,
#     risky: [<segment>…]   world-changing segments that some other non-inert
#                           segment runs BEFORE in the same Bash call (a change
#                           that lands while that one runs is invisible to a
#                           check made before the call),
#     head: "<first world-changing segment, ≤ 120 chars>" }
#
# Segmentation is a small shell lexer, not a parser: it splits on && || ; &
# and newlines outside quotes, parentheses and comments; a pipeline stays one
# segment; `$(…)` stays inside its segment; ( ) and { } groups are split
# through. Quoted text is invisible to the match (`git commit -m "release"`
# is not a release) except for opaque runners (bash -c, sh -c, eval, ssh,
# xargs), whose whole text is matched. Read-only heads (grep, cat, ls, git
# log …) never count as world-changing.

def lex:
  explode as $a
  | ($a | length) as $n
  | reduce range(0; $n) as $i (
      {segs: [], cur: "", bare: "", q: null, esc: false, depth: 0, skip: false, cmt: false};
      ($a[$i] | [.] | implode) as $c
      | (if $i + 1 < $n then ($a[$i + 1] | [.] | implode) else "" end) as $nx
      | (if $i > 0 then ($a[$i - 1] | [.] | implode) else "" end) as $pv
      | if .skip then .skip = false
        elif .cmt then (if $c == "\n" then .cmt = false | .segs += [{raw: .cur, bare: .bare}] | .cur = "" | .bare = "" else . end)
        elif .esc then .esc = false | .cur += $c | (if .q == null then .bare += $c else . end)
        elif .q == "'" then .cur += $c | (if $c == "'" then .q = null | .bare += "Q" else . end)
        elif $c == "\\" then .esc = true | .cur += $c
        elif .q == "\"" then .cur += $c | (if $c == "\"" then .q = null | .bare += "Q" else . end)
        elif $c == "'" or $c == "\"" then .q = $c | .cur += $c
        elif $c == "#" and ($pv == "" or ($pv | test("\\s"))) and .depth == 0 then .cmt = true
        elif $c == "(" and $pv == "$" then .depth += 1 | .cur += $c | .bare += $c
        elif $c == ")" and .depth > 0 then .depth -= 1 | .cur += $c | .bare += $c
        elif .depth > 0 then .cur += $c | .bare += $c
        elif $c == "(" or $c == ")" then .cur += $c | .bare += " "
        elif ($c == "&" and $nx == "&") or ($c == "|" and $nx == "|") then .skip = true | .segs += [{raw: .cur, bare: .bare}] | .cur = "" | .bare = ""
        elif $c == "&" and ($pv == ">" or $pv == "<" or $nx == ">") then .cur += $c | .bare += $c
        elif $c == ";" or $c == "\n" or $c == "&" then .segs += [{raw: .cur, bare: .bare}] | .cur = "" | .bare = ""
        else .cur += $c | .bare += $c
        end)
  | .segs + [{raw: .cur, bare: .bare}]
  | map({raw: (.raw | gsub("^\\s+|\\s+$"; "")), bare: (.bare | gsub("^\\s+|\\s+$"; ""))})
  | map(select(.raw != ""));

# Command words with leading assignments and transparent wrappers removed.
def words:
  [.bare | splits("\\s+") | select(. != "")]
  | until((length == 0) or ((.[0] | test("^[A-Za-z_][A-Za-z0-9_]*=")) or (.[0] | IN("sudo", "env", "time", "nohup", "command", "exec", "nice", "{", "!")) | not); .[1:]);

def base: sub("^.*/"; "");

def part($re; $raw):
  ({bare: .} | words) as $w
  | ($w[0] // "" | base) as $h
  | ($w[1] // "") as $h2
  | ($h | IN("cd", "pushd", "popd", "export", "unset", "set", "source", ".", "true", ":", "echo", "printf", "test", "[", "[[", "alias", "umask", "ulimit", "local", "declare", "shopt")) as $builtin
  | (($h | IN("grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "bat", "less", "more", "head", "tail", "ls", "man", "which", "type", "wc", "file", "stat", "diff", "jq", "yq", "tree", "pwd", "whoami", "date"))
     or ($h == "git" and ($h2 | IN("log", "show", "diff", "status", "grep", "blame", "branch", "remote", "rev-parse", "fetch")))) as $readonly
  | ($h | IN("bash", "sh", "zsh", "dash", "eval", "ssh", "xargs")) as $opaque
  | {inert: ($builtin or $readonly or $h == ""),
     world: ((($builtin or $readonly) | not) and ((if $opaque then $raw else . end) | test($re)))};

# A segment is a pipeline: world-changing when any stage is (or a $( ) runs
# one), inert when every stage is.
def classify($re):
  . as $s
  | [$s.bare | split("|")[] | part($re; $s.raw)] as $p
  | {raw: $s.raw,
     inert: ($p | all(.inert)),
     world: (($p | any(.world)) or ([$s.raw | scan("\\$\\(([^)]*)\\)|`([^`]*)`") | map(. // "") | join(" ")] | join(" ") | test($re)))};

($match | gsub("\\\\\\\\"; "\\")) as $m
| ("(?<![A-Za-z0-9_])(?:" + $m + ")(?![A-Za-z0-9_])") as $re
| ((.tool_input.command // "") | tostring | lex | map(classify($re))) as $segs
| ($segs | map(.world) | index(true)) as $first
| {world: [$segs[] | select(.world) | .raw],
   risky: [range(0; $segs | length) as $i | select($segs[$i].world and ($segs[0:$i] | any(.inert | not))) | $segs[$i].raw],
   head: (if $first == null then "" else ($segs[$first].raw | .[0:120]) end)}
