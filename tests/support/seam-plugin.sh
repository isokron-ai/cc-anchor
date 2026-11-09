#!/usr/bin/env bash
# TEST ONLY. usage: seam-plugin.sh <cc-anchor checkout> — copies its scripts/
# into a new temp dir (under $TMPROOT / $TMPDIR / /tmp), appends to the
# copy's lib.sh a line sourcing tests/support/deadline-seam.sh, and prints
# the copy's root: run the hooks as "$root/scripts/<hook>.sh". The shipped
# scripts/lib.sh is never changed and carries no test seam.
set -euo pipefail
src=$(cd "$1" && pwd)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dest=$(mktemp -d "${TMPROOT:-${TMPDIR:-/tmp}}/cca-seam.XXXXXX")
cp -R "$src/scripts" "$dest/scripts"
printf '\n# Test copy (tests/support/seam-plugin.sh): CLI deadlines are events.\n. %q\n' "$here/deadline-seam.sh" >> "$dest/scripts/lib.sh"
printf '%s\n' "$dest"
