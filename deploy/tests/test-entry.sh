#!/usr/bin/env bash
# The ForceCommand regex: only "deploy|check <40 lowercase hex>" reaches sudo.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
SB=$(mktemp -d); trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/bin"
printf '#!/usr/bin/env bash\necho "sudo $*"\n' > "$SB/bin/sudo"; chmod +x "$SB/bin/sudo"
sed "s|/usr/bin/sudo|$SB/bin/sudo|" "$HERE/../checker-deploy-entry" > "$SB/entry"
S=0123456789abcdef0123456789abcdef01234567
try() { OUT=$(SSH_ORIGINAL_COMMAND="$1" bash "$SB/entry" 2>&1); RC=$?; }
t entry
try "deploy $S"; assert_eq "$RC" 0 "deploy <sha> allowed"; assert_eq "$OUT" "sudo -n /usr/local/sbin/checker-deploy deploy $S" "exact sudo call"
try "check $S"; assert_eq "$RC" 0 "check <sha> allowed"
for bad in "" "id" "deploy" "deploy ${S:0:39}" "deploy ${S}0" "deploy $(tr a-f A-F <<<"$S")" "deploy $S; id" "deploy $S && id" "deploy \$(id)" "rollback $S" " deploy $S" "deploy  $S" "deploy $S
id"; do
  try "$bad"; assert_eq "$RC" 2 "refused: $(printf '%q' "$bad")"
  assert_not_contains "$OUT" "sudo" "no sudo for: $(printf '%q' "$bad")"
done
finish
