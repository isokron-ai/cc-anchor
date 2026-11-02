# cc-anchor — read-only classifier for the PreToolUse gate (scripts/pulse.sh).
#
# 0.5.1: while kronicle-lite reports something pending for the agent (or a
# blocking retraction on kronicle-lite <= 0.7.0, or an integrity failure),
# the gate denies EVERY Bash call except the ones this file can prove are
# read-only. It does not try to find dangerous commands (0.5.0 did, and a
# shell has too many ways to hide one); it accepts a small, conservatively
# parsed allowlist and refuses everything it does not fully understand.
#
# Input: the PreToolUse payload (.tool_input.command). Args: $max (bytes).
# Output (one compact JSON line):
#   { ro: true|false, why: "<why it is not read-only>", head: "<first line, <= 120 chars>" }
#
# Read-only means: a list of simple commands joined by && || ; | or
# newlines, each of them on the allowlist below with only safe options:
#   cat less head tail ls grep egrep fgrep rg find wc diff jq stat basename
#   dirname realpath pwd which echo printf cd true
#   git status|log|diff|show|rev-parse|ls-files|ls-tree|cat-file|blame|
#       describe|merge-base|show-ref|branch (listing only)|remote (-v)
#   kronicle-lite get|pending|orient|doctor|verify-chain|keys (also via npx
#       or node …/kronicle-lite/dist/cli.js)
#   sea-lite board|list|show|whoami|stats|verify|doctor|scope-check (same)
# Refused (not read-only): any other command or a path to one, an
# assignment, a subshell or group, $( ) and backticks, <( ) / >( ), $'…'
# quoting, ${…} forms other than ${NAME}, $1 $@ $? …, here-docs and
# here-strings, `&` (background), any redirection except to /dev/null or an
# fd dup (2>&1), find -exec/-execdir/-ok/-delete/-fprint*/-fls, rg --pre /
# --hostname-bin, less -o/-O/-k/+cmd, git -c and other global options but
# -C/--no-pager, git --output, an unquoted variable / glob / brace in the
# arguments of find, rg, less or git (they could expand into an option), a
# command over $max bytes, an unbalanced quote, or anything unparsed.

def head1: (split("\n") | map(select(test("\\S"))) | first // "") as $l
  | ($l | gsub("^\\s+|\\s+$"; "")) as $t
  | if ($t | length) > 120 then $t[0:119] + "…" else $t end;

# Lexer: one regex scan (fast in C even for long commands), then a reduce
# over the tokens. Alternatives, in order: line continuation, newline,
# blanks, operators, '…', "…", $' and $", ${NAME}, $NAME, a lone $, any
# other $X, backtick, \X, #, a run of plain characters, any other char.
def tokens:
  [scan("\\\\\\n|\\n|[ \\t]+|&&|\\|\\||;;|;|\\|&|\\||&>>|&>|>>|>&|>\\||<<<|<<-?|<&|<>|>|<|&|\\(|\\)|'[^']*'|\"(?:[^\"\\\\]|\\\\[\\s\\S])*\"|\\$'|\\$\"|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$(?![^\\s;&|<>])|\\$[\\s\\S]|`|\\\\[\\s\\S]|#|[^\\s'\"\\\\$`;&|<>()#]+|[\\s\\S]")];

# Parser state helpers. A word is {v, q (any part quoted), dyn (has $NAME),
# glob (unquoted * ? [ or {)}; .redir is the kind of a redirection waiting
# for its target word.
def flush:
  if .cur == null then .
  elif .redir != null then
    (if .redir == "dup" then (if (.cur.v | test("^([0-9]+-?|-|/dev/null)$")) and (.cur.dyn | not) then . else .bad = "a redirection to `\(.cur.v)`" end)
     else (if .cur.v == "/dev/null" and (.cur.dyn | not) and (.cur.glob | not) then . else .bad = "a redirection to a file (`\(.cur.v)`)" end) end)
    | .redir = null | .cur = null
  else .words += [.cur] | .cur = null end;
def endcmd: flush | if .bad != null then . elif .redir != null then .bad = "a redirection without a target"
  else (if (.words | length) > 0 then .cmds += [.words] else . end) | .words = [] end;
def add($p): .cur = ((.cur // {v: "", q: false, dyn: false, glob: false}) as $c | {v: ($c.v + $p.v), q: ($c.q or $p.q), dyn: ($c.dyn or $p.dyn), glob: ($c.glob or $p.glob)});
# An unquoted all-digit word right before a redirection is its fd (2>…).
def redirect($kind): (if .cur != null and (.cur.q | not) and (.cur.v | test("^[0-9]+$")) then .cur = null else flush end)
  | if .bad != null then . elif .redir != null then .bad = "a redirection without a target" else .redir = $kind end;

# One token. Dispatch on its first character with plain string compares:
# jq compiles a regex on every test(), so the common tokens (words, blanks,
# separators) use none.
def step($t):
  ($t[0:1]) as $c
  | if $c == " " or $c == "\t" then flush
  elif $c == "\n" or $c == ";" or $c == "|" or $c == "&" then
    (if $t | IN("\n", "&&", "||", ";", "|", "|&") then endcmd
     elif $t == "&" then .bad = "a background job (`&`)"
     elif $t == ";;" then .bad = "`;;`"
     else redirect("out") end)                                  # &> &>>
  elif $c == ">" then (if $t == ">&" then redirect("dup") else redirect("out") end)
  elif $c == "<" then
    (if $t == "<" then redirect("in")
     elif $t == "<&" then redirect("dup")
     elif $t == "<<<" then .bad = "a here-string"
     elif $t == "<>" then .bad = "a read-write redirection"
     else .bad = "a here-document" end)
  elif $c == "(" or $c == ")" then .bad = "a subshell, process substitution or ( )"
  elif $c == "`" then .bad = "command substitution (backticks)"
  elif $c == "#" then (if .cur == null and .redir == null then .cmt = true else add({v: "#", q: false, dyn: false, glob: false}) end)
  elif $c == "\\" then (if $t == "\\\n" then . else add({v: $t[1:], q: true, dyn: false, glob: false}) end)
  elif $c == "'" then
    (if ($t | length) >= 2 and ($t | endswith("'")) then add({v: $t[1:-1], q: true, dyn: false, glob: false}) else .bad = "an unbalanced quote" end)
  elif $c == "\"" then
    (if ($t | length) < 2 or ($t | endswith("\"") | not) then .bad = "an unbalanced quote"
     elif ($t | contains("$") or contains("`") or contains("\\")) | not then add({v: $t[1:-1], q: true, dyn: false, glob: false})
     else ($t[1:-1]) as $in
       | ($in | gsub("\\\\[\\s\\S]"; "_")) as $chk
       | if ($chk | test("`")) then .bad = "command substitution (backticks)"
         elif ($chk | test("\\$\\(")) then .bad = "command substitution `$( )`"
         elif ($chk | gsub("\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*"; "") | test("\\$[^\\s]")) then .bad = "a shell expansion other than $NAME / ${NAME}"
         else add({v: ($in | gsub("\\\\\\n"; "") | gsub("\\\\(?<c>[\\\\$`\"])"; .c)), q: true, dyn: ($chk | test("\\$[A-Za-z_{]")), glob: false})
         end
     end)
  elif $c == "$" then
    (if $t == "$" then add({v: "$", q: false, dyn: false, glob: false})
     elif $t == "$'" or $t == "$\"" then .bad = "$'…' / $\"…\" quoting"
     elif $t | test("^\\$(\\{[A-Za-z_][A-Za-z0-9_]*\\}|[A-Za-z_][A-Za-z0-9_]*)$") then add({v: $t, q: false, dyn: true, glob: false})
     elif $t == "$(" then .bad = "command substitution `$( )`"
     else .bad = "the shell expansion `\($t)…`" end)
  elif ($t | length) == 1 and ($t | test("^\\s$")) then .bad = "a character the gate does not parse (\($t | @json))"
  else add({v: $t, q: false, dyn: false, glob: ($t | contains("*") or contains("?") or contains("[") or contains("{"))})
  end;

# Parse into {cmds: [[word…]…]} or {bad: "<why>"}. A comment (# at the start
# of a word) runs to the end of the line, as in bash.
def parse:
  reduce tokens[] as $t ({cmds: [], words: [], cur: null, redir: null, bad: null, cmt: false};
    if .bad != null then .
    elif .cmt then (if $t == "\n" or $t == "\\\n" then .cmt = false | endcmd else . end)
    else step($t) end)
  | if .bad == null then endcmd else . end
  | if .bad != null then {bad} else {cmds} end;

def lit: (.dyn or .glob) | not;
def vals: map(.v);

# git: global options -C <dir>, --no-pager, -P, --no-optional-locks only.
def git_ok:
  . as $a
  | (reduce range(0; $a | length) as $i ({i: 0, bad: null, done: false};
      if .done or .bad != null or $i < .i then .
      else ($a[$i].v) as $w
        | if $w == "-C" then .i = $i + 2
          elif $w | IN("--no-pager", "-P", "--no-optional-locks") then .i = $i + 1
          elif $w | startswith("-") then .bad = "the git option `\($w)`"
          else .i = $i | .done = true end
      end)) as $g
  | if $g.bad != null then $g.bad
    elif ($g.done | not) then null
    else ($a[$g.i:]) as $r
      | ($r[0].v) as $sub
      | ($r[1:]) as $args
      | if ($r[0] | lit | not) then "a git subcommand that is not literal"
        elif ($args | any(lit | not)) then "an unquoted variable, glob or brace in git's arguments"
        elif $sub | IN("status", "rev-parse", "ls-files", "ls-tree", "cat-file", "blame", "describe", "merge-base", "show-ref") then null
        elif $sub | IN("log", "diff", "show", "whatchanged") then
          (if ($args | any(.v | test("^--ou"))) then "git \($sub) --output (writes a file)" else null end)
        elif $sub == "remote" then
          (if ($args | all(.v | IN("-v", "--verbose"))) then null else "git remote with arguments (only `git remote -v` is read-only)" end)
        elif $sub == "branch" then
          ($args | vals) as $v
          | if ($v | any(IN("--list", "-l") or test("^-[arv]*l[arv]*$"))) then
              (if ($v | any(test("^(-[^-]*[dDmMcCfut]|--(d|mo|cop|fo|se|un|ed|tr|no-t|cr))"))) then "git branch with an option that changes branches" else null end)
            else
              ($v | reduce .[] as $x ({ok: true, val: false};
                if .val then .val = false
                elif ($x | IN("--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format")) then .val = true
                elif ($x | test("^(-[arv]+|--all|--remotes|--verbose|--show-current|--no-color|--color(=.*)?|--format=.*|--sort=.*|--column(=.*)?|--no-column|--ignore-case|--abbrev=.*|--no-abbrev|--(no-)?contains=.*|--(no-)?merged=.*|--points-at=.*)$")) then .
                else .ok = false end)) as $s
            | if $s.ok then null else "git branch with arguments that create, rename or delete a branch" end
            end
        else "`git \($sub)` is not on the read-only list"
        end
    end;

# kronicle-lite / sea-lite read commands; the words after the CLI itself.
def cli_ok($tool):
  (if $tool == "kronicle-lite" then ["get", "pending", "orient", "doctor", "verify-chain", "keys", "--version", "--help", "help"]
   else ["board", "list", "show", "whoami", "stats", "verify", "doctor", "scope-check", "--version", "--help", "help"] end) as $subs
  | if length == 0 then "`\($tool)` with no subcommand"
    elif (.[0] | lit | not) then "a \($tool) subcommand that is not literal"
    elif (.[0].v | IN($subs[])) then (if (.[1:] | any(.glob)) then "an unquoted glob or brace in \($tool)'s arguments" else null end)
    else "`\($tool) \(.[0].v)` is not on the read-only list" end;

def cmd_ok:
  .[0] as $c0 | .[1:] as $args
  | ($c0.v) as $name
  | if $c0.dyn then "a command name that is a variable"
    elif $c0.glob then "a command name with a glob"
    elif ($c0.q | not) and ($name | test("^[A-Za-z_][A-Za-z0-9_]*\\+?=")) then "a variable assignment (`\($name | .[0:40])`)"
    elif ($name | test("/")) and ($name | test("^/(usr/local/|usr/|opt/homebrew/)?bin/[^/]+$") | not) then "`\($name | .[0:60])` (a path to a program or script) is not on the read-only list"
    else ($name | sub("^.*/"; "")) as $b
      | if $b | IN("cat", "head", "tail", "ls", "wc", "diff", "pwd", "which", "echo", "printf", "grep", "egrep", "fgrep", "jq", "stat", "basename", "dirname", "realpath", "cd", "true") then null
        elif $b == "find" then
          (if ($args | any(lit | not)) then "an unquoted variable, glob or brace in find's arguments (quote patterns: -name '*.js')"
           elif ($args | any(.v | IN("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"))) then "find with \($args | map(.v | select(IN("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"))) | first)"
           else null end)
        elif $b == "rg" then
          (if ($args | any(lit | not)) then "an unquoted variable, glob or brace in rg's arguments (quote them: -g '*.ts')"
           elif ($args | any(.v | test("^--(pre($|=)|hostname-bin)"))) then "rg --pre / --hostname-bin (runs a program)"
           else null end)
        elif $b == "less" then
          (if ($args | any(lit | not)) then "an unquoted variable, glob or brace in less's arguments"
           elif ($args | any(.v | test("^\\+") or (test("^-[^-]") and (test("^-[NRSFXriInMmEeKsQqw~]+$") | not)) or (test("^--") and (IN("--no-init", "--quit-if-one-screen", "--RAW-CONTROL-CHARS", "--chop-long-lines", "--LINE-NUMBERS", "--ignore-case", "--quiet") | not)))) then "a less option that is not on the read-only list"
           else null end)
        elif $b == "git" then ($args | git_ok)
        elif $b | IN("kronicle-lite", "sea-lite") then ($args | cli_ok($b))
        elif $b == "npx" then
          ($args | (until(length == 0 or (.[0].v | IN("-y", "--yes", "-q", "--quiet") | not); .[1:])) as $r
            | if ($r | length) > 0 and ($r[0] | lit) and ($r[0].v | test("^(kronicle-lite|sea-lite)(@[A-Za-z0-9._^~<>=-]+)?$")) then ($r[1:] | cli_ok($r[0].v | sub("@.*$"; "")))
              else "`npx \($r[0].v // "")` is not on the read-only list" end)
        elif $b | IN("node", "nodejs") then
          (if ($args | length) > 0 and ($args[0] | lit) and ($args[0].v | test("(^|/)(kronicle-lite|sea-lite)/dist/cli\\.js$")) then ($args[1:] | cli_ok($args[0].v | capture("(?<t>kronicle-lite|sea-lite)/dist/cli\\.js$").t))
           else "`node` running a script is not on the read-only list" end)
        else "`\($b | .[0:60])` is not on the read-only list"
        end
    end;

((.tool_input.command // "") | tostring) as $cmd
| ($max | tonumber? // 8192) as $lim
| ($cmd | head1) as $head
| (if ($cmd | utf8bytelength) > $lim then {ro: false, why: "the command is longer than \($lim) bytes", head: $head}
   else ($cmd | parse) as $p
     | if $p.bad != null then {ro: false, why: $p.bad, head: $head}
       else ([$p.cmds[] | cmd_ok | select(. != null)] | first) as $why
         | {ro: ($why == null), why: ($why // ""), head: $head}
       end
   end)
# --arg fmt line (pulse.sh): one "ro\u001fwhy\u001fhead" line for bash.
| if ($ARGS.named.fmt // "") == "line" then "\(.ro)\u001f\(.why | gsub("[[:cntrl:]]"; " "))\u001f\(.head | gsub("[[:cntrl:]]"; " "))" else . end
