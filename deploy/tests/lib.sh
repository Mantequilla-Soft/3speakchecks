# Tiny assertion helpers shared by the deploy tests. Source it, call `t <name>` to
# start a case, the assert_* helpers inside it, and `finish` at the end.

PASS=0; FAIL=0; CURRENT=""
t() { CURRENT="$1"; }
ok() { PASS=$((PASS + 1)); printf '  ok    %s: %s\n' "$CURRENT" "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s: %s\n' "$CURRENT" "$1"; }

assert_eq() {   # actual expected message
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi
}
assert_contains() {   # haystack needle message
  if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 (missing '$2')"; fi
}
assert_not_contains() {
  if grep -qF -- "$2" <<<"$1"; then bad "$3 (found '$2')"; else ok "$3"; fi
}
assert_file() { if [ -e "$1" ]; then ok "$2"; else bad "$2 ($1 missing)"; fi; }
assert_no_file() { if [ -e "$1" ]; then bad "$2 ($1 exists)"; else ok "$2"; fi; }

finish() {
  echo
  echo "$PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}
