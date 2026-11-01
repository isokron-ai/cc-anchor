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
#     oneliner: [<segment>…] world-changing code inside an interpreter one-liner
#                           (python -c, node -e, perl/ruby -e, bash/sh/zsh -c,
#                           eval): the pulse cannot see when it runs; denied once,
#     head: "<first world-changing segment, ≤ 120 chars>" }
#
# Segmentation is a small shell lexer, not a parser: it splits on && || ; &
# and newlines outside quotes, parentheses and comments; a pipeline stays one
# segment; `$(…)` stays inside its segment; ( ) and { } groups are split
# through. Each pipeline stage is then tokenized (quotes removed, whitespace
# collapsed), wrappers and their options are dropped (sudo -E, env -i, nice -n,
# timeout 600 …), and the tool's own global options are skipped before the
# match (`git -C x --no-pager push` → `git push`, `kubectl -n prod apply`,
# `terraform -chdir=infra apply`, `npm --prefix x publish`). Quoted ARGUMENTS
# stay invisible (`git commit -m "release"` is not a release); a quoted command
# name is not (`"git" push`). The code of interpreter one-liners is matched
# (python -c, node -e, perl/ruby -e, bash/sh/zsh -c, eval), as is the whole
# text of ssh / xargs. Read-only commands (grep, cat, ls, git log …) never
# count as world-changing. This is defence in depth: a command the regex does
# not name, or one that runs inside a script, is only caught by an exec-time
# check (kronicle-lite shims).

# Code of an interpreter (one-liner or here-doc) as plain words, so
# subprocess.run(['git','push']) and execFileSync('npm', ['publish']) read as
# "git push" / "npm publish".
def codewords: gsub("[\\[\\]'\"`,()]"; " ") | gsub("\\s+"; " ");

def interp: sub("^.*/"; "") | test("^(bash|sh|zsh|dash|ksh|python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php)$");

# Here-documents: [{d: delimiter, head: the line that opens it, body: text}].
# The body is cut out before lexing (its quotes and semicolons are not shell)
# and scanned as code when an interpreter reads it.
def heredocs:
  split("\n") as $L
  | reduce range(0; $L | length) as $i ({out: [], cur: null};
      if .cur != null then
        (if ($L[$i] | sub("^\\t+"; "")) == .cur.d then .out += [.cur] | .cur = null
         else .cur.body += [$L[$i]] end)
      else ([$L[$i] | capture("<<-?\\s*['\"]?(?<d>[A-Za-z_][A-Za-z0-9_]*)['\"]?")] | first) as $m
        | if $m == null then . else .cur = {d: $m.d, head: $L[$i], body: []} end
      end)
  | .out + (if .cur != null then [.cur] else [] end)
  | map(.body |= join("\n"));

# The command without here-doc bodies (and their closing delimiter lines).
def strip_heredocs:
  split("\n") as $L
  | reduce range(0; $L | length) as $i ({keep: [], d: null};
      if .d != null then (if ($L[$i] | sub("^\\t+"; "")) == .d then .d = null else . end)
      else .keep += [$L[$i]]
        | ([$L[$i] | capture("<<-?\\s*['\"]?(?<d>[A-Za-z_][A-Za-z0-9_]*)['\"]?")] | first) as $m
        | if $m == null then . else .d = $m.d end
      end)
  | .keep | join("\n");

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

# Words of one pipeline stage with shell-ish quoting: {w: text with quotes
# removed, q: true when any part was quoted}. Whitespace (spaces, tabs) is
# collapsed; `|` outside quotes ends a stage.
def stages:
  explode as $a
  | reduce range(0; $a | length) as $i (
      {st: [], ws: [], cur: null, q: null, esc: false};
      ($a[$i] | [.] | implode) as $c
      | if .esc and $c == "\n" then .esc = false | (if .cur != null then .ws += [.cur] | .cur = null else . end)
        elif .esc then .esc = false | .cur = ((.cur // {w: "", q: false}) | .w += $c)
        elif .q == "'" then (if $c == "'" then .q = null else .cur.w += $c end)
        elif .q == "\"" then (if $c == "\"" then .q = null elif $c == "\\" then .esc = true else .cur.w += $c end)
        elif $c == "\\" then .esc = true
        elif $c == "'" or $c == "\"" then .q = $c | .cur = ((.cur // {w: "", q: false}) | .q = true)
        elif $c | test("\\s") then (if .cur != null then .ws += [.cur] | .cur = null else . end)
        elif $c == "|" then (if .cur != null then .ws += [.cur] | .cur = null else . end) | .st += [.ws] | .ws = []
        else .cur = ((.cur // {w: "", q: false}) | .w += $c)
        end)
  | (if .cur != null then .ws += [.cur] else . end)
  | .st + [.ws];

def base: sub("^.*/"; "");

# Drop leading assignments and transparent wrappers WITH their own options
# (sudo -E, env -i A=b, nice -n 10, timeout 600, time, nohup, command, exec).
def unwrap:
  if length == 0 then .
  elif (.[0].q | not) and (.[0].w | test("^[A-Za-z_][A-Za-z0-9_]*=")) then .[1:] | unwrap
  elif .[0].w | IN("time", "nohup", "command", "exec", "!", "{", "(") then .[1:] | unwrap
  elif .[0].w == "sudo" then .[1:] | until(length == 0 or (.[0].w | startswith("-") | not); if .[0].w | IN("-u", "-g", "-C", "-h", "-p", "-r", "-t") then .[2:] else .[1:] end) | unwrap
  elif .[0].w == "env" then .[1:] | until(length == 0 or ((.[0].w | startswith("-")) or (.[0].w | test("^[A-Za-z_][A-Za-z0-9_]*=")) | not); if .[0].w | IN("-u", "-C", "-S") then .[2:] else .[1:] end) | unwrap
  elif .[0].w == "nice" then .[1:] | (if (.[0].w // "") == "-n" then .[2:] elif (.[0].w // "") | test("^-") then .[1:] else . end) | unwrap
  elif .[0].w == "timeout" then .[1:] | until(length == 0 or (.[0].w | startswith("-") | not); if .[0].w | IN("-s", "-k", "--signal", "--kill-after") then .[2:] else .[1:] end) | .[1:] | unwrap
  else . end;

# Skip a tool's global options so `git -C x push`, `kubectl -n prod apply`,
# `terraform -chdir=infra apply` read as `git push` / `kubectl apply` / …
def skipopts($tool):
  def go($val; $flags):
    until(length == 0 or (.[0].w | startswith("-") | not);
      if (.[0].w | IN($val[])) then .[2:] else .[1:] end);
  if $tool == "git" then go(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]; [])
  elif $tool == "kubectl" or $tool == "oc" then go(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--as", "--as-group", "--token", "--request-timeout", "-v", "--certificate-authority"]; [])
  elif $tool == "terraform" or $tool == "tofu" then go([]; [])
  elif $tool == "npm" or $tool == "pnpm" or $tool == "yarn" then go(["--prefix", "-w", "--workspace", "-C", "--dir", "--cwd", "--filter"]; [])
  elif $tool == "helm" then go(["-n", "--namespace", "--kube-context", "--kubeconfig"]; [])
  elif $tool == "make" then go(["-C", "-f", "--directory", "--file", "-j"]; [])
  else . end;

# Interpreter one-liners: the code string they run (null when not one).
def oneliner_code:
  (.[0].w | base) as $x
  | (if $x | test("^(bash|sh|zsh|dash|ksh)$") then ["-c"]
     elif $x | test("^python[0-9.]*$") then ["-c"]
     elif $x | test("^(node|nodejs|deno|bun)$") then ["-e", "-p", "--eval", "--print"]
     elif $x | test("^(perl|ruby)$") then ["-e", "-E"]
     else null end) as $flags
  | if $x == "eval" then (.[1:] | map(.w) | join(" "))
    elif $flags == null then null
    else (. as $w | [range(1; length) | select(($w[.].w | IN($flags[])) or ($flags == ["-c"] and ($w[.].w | test("^-[A-Za-z]*c$"))))] | first) as $i
      | if $i == null then null else (.[$i + 1].w // "") end
    end;

def part($re; $raw):
  (unwrap) as $u
  | ($u[0].w // "" | base) as $h
  | ($u[1:] | skipopts($h)) as $args
  # The verb (first argument after the tool's global options) counts even
  # when quoted ("git" "push"); later quoted arguments never do.
  | ($args | if $h == "git" and length > 1 and (.[0].w | IN("subtree", "lfs")) then .[1:] else . end) as $args
  | ([$h] + ($args | to_entries | map(if .key == 0 then .value.w elif .value.q then "Q" else .value.w end))) as $cw
  | ($cw[1] // "") as $h2
  | ($cw | join(" ")) as $canon
  | ($h | IN("cd", "pushd", "popd", "export", "unset", "set", "source", ".", "true", ":", "echo", "printf", "test", "[", "[[", "alias", "umask", "ulimit", "local", "declare", "shopt")) as $builtin
  | (($h | IN("grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "bat", "less", "more", "head", "tail", "ls", "man", "which", "type", "wc", "file", "stat", "diff", "jq", "yq", "tree", "pwd", "whoami", "date"))
     or ($h == "git" and ($h2 | IN("log", "show", "diff", "status", "grep", "blame", "branch", "remote", "rev-parse", "fetch")))) as $readonly
  | ($u | oneliner_code) as $code
  | ($code != null and ($code | codewords | test($re))) as $oneliner
  | ($h | IN("ssh", "xargs")) as $opaque
  | {inert: ($builtin or $readonly or $h == ""),
     oneliner: $oneliner,
     world: ($oneliner or ((($builtin or $readonly) | not) and (($canon | test($re)) or ($opaque and ($raw | test($re))))))};

# A segment is a pipeline: world-changing when any stage is (or a $( ) runs
# one), inert when every stage is.
def classify($re; $hd):
  . as $s
  | [$s.raw | stages[] | select(length > 0)] as $st
  | [$st[] | part($re; $s.raw)] as $p
  # A here-doc read by an interpreter (python3 - <<PY, cat <<EOF | bash) is
  # code: scan its body like a one-liner's.
  | ([$s.raw | capture("<<-?\\s*['\"]?(?<d>[A-Za-z_][A-Za-z0-9_]*)['\"]?")] | first) as $m
  | (if $m == null then null else ([$hd[] | select(.d == $m.d)] | first | .body // null) end) as $body
  | ($body != null and ([$st[] | (.[0].w // "") | interp] | any) and ($body | codewords | test($re))) as $hdoc
  | {raw: $s.raw,
     inert: ($p | all(.inert)),
     oneliner: (($p | any(.oneliner)) or $hdoc),
     world: (($p | any(.world)) or $hdoc or ([$s.raw | scan("\\$\\(([^)]*)\\)|`([^`]*)`") | map(. // "") | join(" ")] | join(" ") | test($re)))};

($match | gsub("\\\\\\\\"; "\\")) as $m
| ("(?<![A-Za-z0-9_])(?:" + $m + ")(?![A-Za-z0-9_])") as $re
| ((.tool_input.command // "") | tostring | gsub("\\\\\n"; " ")) as $cmd
| ($cmd | heredocs) as $hd
| ($cmd | strip_heredocs | lex | map(classify($re; $hd))) as $segs
| ($segs | map(.world) | index(true)) as $first
| {world: [$segs[] | select(.world) | .raw],
   risky: [range(0; $segs | length) as $i | select($segs[$i].world and ($segs[0:$i] | any(.inert | not))) | $segs[$i].raw],
   oneliner: [$segs[] | select(.oneliner) | .raw | .[0:120]],
   head: (if $first == null then "" else ($segs[$first].raw | .[0:120]) end)}
