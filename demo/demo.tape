# cc-anchor demo — record with https://github.com/charmbracelet/vhs:
#   cd some-project && vhs /path/to/cc-anchor/demo/demo.tape
# Assumes the plugin is installed (claude plugin marketplace add rafe-walker/cc-anchor
# && claude plugin install cc-anchor@cc-anchor) and the project has a file to read.
Output demo.gif
Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "claude" Enter
Sleep 5s

Type '/cc-anchor:anchor set project "Payments service — Go, Postgres, Stripe"' Enter
Sleep 7s
Type '/cc-anchor:anchor set goal "Migrate webhooks to the v2 signature scheme"' Enter
Sleep 7s
Type '/cc-anchor:anchor add-invariant "never change the public API without a changelog entry"' Enter
Sleep 7s
Type '/cc-anchor:anchor statusline install' Enter
Sleep 8s

Type 'Read README.md and summarise it in one line.' Enter
Sleep 12s

Type '/compact' Enter
Sleep 20s

Type 'Without re-reading any file: what is the goal, what are the invariants, and which file was I in? Quote the anchor card.' Enter
Sleep 15s

Type 'anchor' Enter
Sleep 10s
