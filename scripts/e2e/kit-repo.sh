#!/bin/sh
# Builds case88's throwaway git repo INSIDE the container, as the node user:
#   docker exec -i n8n-cc-e2e sh -s < scripts/e2e/kit-repo.sh
#
# Not under /workspace: that is a bind mount of fixture-project/, and turning it into a repo would
# put a .git in the host checkout. Fixed identities and dates make every SHA reproducible, so the
# verdict can name the merge base outright.
#
# main (HEAD) = kit-base + one change. Expected diff kit-base..HEAD:
#   src/calc.js       modified  +5 -1  added lines 2, 9, 10, 11, 12 (two hunks)
#   src/new.js        added     +3 -0  added lines 1, 2, 3
#   src/new name.js   renamed from "src/old name.js"  +1 -0  added line 5
#   docs/notes.md     deleted   +0 -2
# kit-shifted = HEAD + three lines inserted above everything in src/calc.js (line 10 -> 13).
# kit-edited  = HEAD + line 10 of src/calc.js reworded.
set -eu

REPO="${1:-/home/node/kit-repo}"
rm -rf "$REPO"
mkdir -p "$REPO/src" "$REPO/docs"
cd "$REPO"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid
export GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid
commit() {
	GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"
}

git init -q -b main .

printf '%s\n' \
	'"use strict";' \
	'function add(a, b) {' \
	'  return a + b;' \
	'}' \
	'function sub(a, b) {' \
	'  return a - b;' \
	'}' \
	'module.exports = { add, sub };' >src/calc.js
printf '%s\n' '# Notes' 'This file is deleted by the change.' >docs/notes.md
printf '%s\n' \
	'const greeting = "hello";' \
	'const target = "world";' \
	'const message = greeting + ", " + target;' \
	'module.exports = { message };' >'src/old name.js'
git add -A
commit '2026-01-01T00:00:00Z' 'base'
git tag kit-base

CALC_HEAD='"use strict";
// calculator helpers
function add(a, b) {
  return a + b;
}
function sub(a, b) {
  return a - b;
}
function mul(a, b) {
  return a * b;
}
module.exports = { add, sub, mul };'
printf '%s\n' "$CALC_HEAD" >src/calc.js
printf '%s\n' 'const { add } = require("./calc");' 'const two = add(1, 1);' 'module.exports = { two };' >src/new.js
git rm -q docs/notes.md
git mv 'src/old name.js' 'src/new name.js'
printf '%s\n' 'module.exports.shout = message.toUpperCase();' >>'src/new name.js'
git add -A
commit '2026-01-02T00:00:00Z' 'change'

git checkout -q -b kit-shifted
{
	printf '%s\n' '"use strict";' '// Three lines above every anchor.' '// They must not change a fingerprint.' ''
	printf '%s\n' "$CALC_HEAD" | tail -n +2
} >src/calc.js
git add -A
commit '2026-01-03T00:00:00Z' 'shift'

git checkout -q main
git checkout -q -b kit-edited
printf '%s\n' "$CALC_HEAD" | sed 's/  return a \* b;/  return b * a;/' >src/calc.js
git add -A
commit '2026-01-04T00:00:00Z' 'edit'

git checkout -q main
echo "==> kit repo: $REPO  kit-base=$(git rev-parse kit-base)  HEAD=$(git rev-parse HEAD)"
