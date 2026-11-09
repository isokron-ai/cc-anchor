# shellcheck shell=bash
# TEST ONLY: never sourced by the shipped hooks. Sourced after scripts/lib.sh
# by the sea-lite stress harnesses (through a test copy of scripts/ made by
# tests/support/seam-plugin.sh) and by tests/hooks.test.mjs.
#
# It replaces cc_with_timeout so that a CLI deadline is an event, not a clock:
# the command runs with CC_ANCHOR_DEADLINE=<fifo> and expires when a line is
# written to that FIFO — by a test double playing "hung", which writes it and
# then blocks — and never otherwise. Whether a CLI call timed out is then
# decided by the test, not by how loaded the machine is (the real sea-lite
# CLI missed scope_timeout under load and the guards failed open, as
# designed). Same process-group kill and exit 124 as the real one.
#
# Until the 0.6.0 review this lived in scripts/lib.sh behind the environment
# variable alone, so any session could set it: a missing directory made the
# scope guard allow the edit at once (exit 125), a real one removed the
# deadline. The shipped lib.sh now has no seam at all; the variable means
# something only where this file was sourced.
#
# Without CC_ANCHOR_TEST_DEADLINE_DIR the real (clock) cc_with_timeout runs.
eval "cc_with_timeout_clock() $(declare -f cc_with_timeout | sed '1d')"
cc_with_timeout() {
  [[ -n "${CC_ANCHOR_TEST_DEADLINE_DIR:-}" ]] || { cc_with_timeout_clock "$@"; return; }
  shift
  local f
  f="$(mktemp -u "${CC_ANCHOR_TEST_DEADLINE_DIR%/}/dl.XXXXXXXX")" && mkfifo -m 600 "$f" 2>/dev/null \
    || { echo "deadline-seam: cannot make a FIFO in $CC_ANCHOR_TEST_DEADLINE_DIR" >&2; return 125; }
  (
    set -m
    CC_ANCHOR_DEADLINE="$f" "$@" </dev/null &
    cmd=$!
    # A plain read-open (O_RDWR on a FIFO is not portable: it hung on macOS).
    ( IFS= read -r _ < "$f"; : > "$f.fired"; kill -TERM -- "-$cmd" ) </dev/null >/dev/null 2>&1 &
    dog=$!
    wait "$cmd"; rc=$?
    kill -TERM -- "-$dog" 2>/dev/null
    if [[ -e "$f.fired" ]]; then rc=124; fi
    rm -f "$f" "$f.fired" 2>/dev/null
    exit "$rc"
  )
}
