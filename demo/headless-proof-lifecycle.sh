#!/usr/bin/env bash
# cc-anchor 0.2.0 — headless proof that the lifecycle hooks fire live.
#
# Runs a short `claude -p` session (one Read tool call, then the model stops)
# with the plugin loaded from this checkout and the sea-lite claim guard
# switched on, after seeding claims.json with a live claim. Expected in the
# stream (printed as `hook_response <HookName> …`):
#
#   SessionStart        → additionalContext with the card (startup header)
#   InstructionsLoaded  → (observe-only; fires if a CLAUDE.md exists)
#   PreToolUse Read     → not matched (matcher is Edit|Write|…): no line
#   PostToolUse Read    → empty response (breadcrumb appended to the trail)
#   Stop #1             → {"decision":"block","reason":"release or hand off your sea-lite claim first …"}
#   Stop #2             → nothing (blocked once; stop_hook_active on the retry)
#
# Costs a few cents on Sonnet. Requires `claude` logged in.
#
#   bash demo/headless-proof-lifecycle.sh [extra claude flags…]
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'echo "work dir kept at $WORK"' EXIT
cd "$WORK" && git init -q
printf 'hello from the proof\n' > note.txt
printf '# proof project\n' > CLAUDE.md
node "$PLUGIN_ROOT/scripts/anchor.mjs" set goal "Prove the lifecycle hooks fire" >/dev/null
node "$PLUGIN_ROOT/scripts/anchor.mjs" config set claim_guard true >/dev/null
# Seed one live claim exactly as the PostToolUse hook would have recorded it.
printf '%s' '{"session_id":"seed","cwd":"'"$WORK"'","hook_event_name":"PostToolUse","tool_name":"mcp__sea-lite__sea_claim","tool_input":{"ticket_ids":["tkt_proof"]},"tool_response":{"content":[{"type":"text","text":"{\"claims\":[{\"ticket_id\":\"tkt_proof\",\"claim_token\":\"clm_proof_token\",\"expires_at\":\"2099-01-01T00:00:00Z\"}]}"}]}}' \
  | CLAUDE_PROJECT_DIR="$WORK" bash "$PLUGIN_ROOT/scripts/post-tool-use.sh"

claude -p "Use the Read tool on note.txt, then reply with exactly: DONE" \
  --max-turns 6 --allowedTools Read --plugin-dir "$PLUGIN_ROOT" \
  --output-format stream-json --verbose "$@" </dev/null 2>/dev/null \
  | tee stream.jsonl \
  | jq -R 'fromjson? | select(.subtype=="hook_started" or .subtype=="hook_response")
           | "\(.subtype) \(.hook_name) \(.hook_event // "") \((.output // "")[0:160])"'

echo; echo "== .claude/anchor.md"; cat .claude/anchor.md
echo; echo "== claims.json"; cat .claude/cc-anchor/claims.json; echo
echo "== state.json"; cat .claude/cc-anchor/state.json; echo
echo "== log"; cat .claude/cc-anchor/log 2>/dev/null || true
