#!/usr/bin/env bash
# cc-anchor — reproducible headless proof that the compaction bracket fires.
#
# Creates a throwaway project, sets a goal + invariant, then runs `claude -p`
# with a 100k auto-compact window and four ~50k-token files so the session
# auto-compacts (costs roughly US$0.60 on Sonnet). Streams the hook events
# and prints the card + state afterwards. Requires the plugin to be installed
# (or pass --plugin-dir /path/to/cc-anchor).
#
#   bash demo/headless-proof.sh [extra claude flags…]
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'echo "work dir kept at $WORK"' EXIT
cd "$WORK" && git init -q
python3 - <<'PY'
import random
words = ['anchor','bracket','compaction','cursor','invariant','breadcrumb','drift','sextant','kronicle','goal']
random.seed(1)
for n in ('big1.txt','big2.txt','big3.txt','big4.txt'):
    with open(n, 'w') as f:
        for i in range(2000):
            f.write(f'{i:05d} ' + ' '.join(random.choice(words) for _ in range(12)) + '\n')
PY
node "$PLUGIN_ROOT/scripts/anchor.mjs" set goal "Prove the compaction bracket fires" >/dev/null
node "$PLUGIN_ROOT/scripts/anchor.mjs" add-invariant "never delete big*.txt" >/dev/null

claude -p "Read big1.txt in full, then big2.txt, then big3.txt, then big4.txt (use the Read tool each time). After each read say which file you read. Finally reply with exactly: FINISHED" \
  --max-turns 14 --allowedTools Read --autocompact 100k \
  --output-format stream-json --verbose "$@" </dev/null 2>/dev/null \
  | tee stream.jsonl \
  | jq -R 'fromjson? | select(.subtype=="hook_started" or .subtype=="hook_response" or .subtype=="compact_boundary")
           | if .subtype=="compact_boundary" then "COMPACT \(.compact_metadata.trigger) pre=\(.compact_metadata.pre_tokens) post=\(.compact_metadata.post_tokens)"
             else "\(.subtype) \(.hook_name) \((.output // "")[0:90])" end'

echo; echo "== .claude/anchor.md"; cat .claude/anchor.md
echo; echo "== state.json (compact_count = PreCompact firings)"; cat .claude/cc-anchor/state.json; echo
