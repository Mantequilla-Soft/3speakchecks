#!/usr/bin/env bash
# Tests for checker-deploy, run against a sandbox: a throwaway git origin with `main`, a
# checkout carrying a local adServe.js patch, and stubs for everything the script does to
# the box (runuser, systemctl, curl, npm, sleep). Real git, node --check and flock.
# The script under test is a copy whose paths are rewritten into the sandbox; the copy is
# checked for leftover real paths before anything runs.
#
#   bash test-deploy.sh            all cases
#   bash test-deploy.sh rollback   only cases whose name contains "rollback"
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
SRC="${DEPLOY_SCRIPT:-$HERE/../checker-deploy}"
ONLY="${1:-}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
GIT_ID=(-c user.name=tibfox -c user.email=tibfox@gmail.com)
REAL_PATH="$PATH"

patch_script() {
  local s
  s=$(sed \
    -e "s|^CONF=.*|CONF=$SB/checker-deploy.conf|" \
    -e "s|^STATE_DIR=.*|STATE_DIR=$SB/state|" \
    -e "s|^LOG=.*|LOG=$SB/deploy.log|" \
    -e "s|^LOCK=.*|LOCK=$SB/deploy.lock|" \
    -e "s|^SYS_PATH=.*|SYS_PATH=$SB/bin:$REAL_PATH|" \
    -e "s|^BOOT_WAIT_SECONDS=.*|BOOT_WAIT_SECONDS=2|" \
    -e "s|^LOCK_WAIT_SECONDS=.*|LOCK_WAIT_SECONDS=2|" \
    "$SRC")
  if grep -nE '/etc/|/var/|/run/|/mnt/|/opt/' <<<"$s" | grep -v '^[0-9]*:#'; then
    echo "the patched script still references real paths (above); update patch_script"; exit 1
  fi
  printf '%s\n' "$s" > "$SB/deploy"; chmod +x "$SB/deploy"
}

stub() {   # name dir: a logging stub with $SB baked in
  { echo '#!/usr/bin/env bash'; echo "SB=$SB"; echo 'echo "'"$1"' $*" >> "$SB/calls.log"'; cat; } > "$2/$1"
  chmod +x "$2/$1"
}

make_stubs() {
  stub runuser "$SB/bin" <<'EOF'
[ "$1" = -u ] && shift 2
[ "$1" = -- ] && shift
exec "$@"
EOF
  stub sleep "$SB/bin" <<<'exit 0'
  stub npm "$SB/nodebin" <<'EOF'
[ -f "$SB/ctl/npm_fail" ] && exit 1
exit 0
EOF
  ln -s "$(command -v node)" "$SB/nodebin/node"
  # systemctl: restart/stop are logged; MainPID is stable unless ctl/crashloop exists.
  stub systemctl "$SB/bin" <<'EOF'
case "$1" in
  restart) rm -f "$SB/ctl/stopped" ;;
  stop) touch "$SB/ctl/stopped" ;;
  is-active) [ -f "$SB/ctl/stopped" ] && exit 3; exit 0 ;;
  show)
    if [ -f "$SB/ctl/crashloop" ]; then n=$(( $(cat "$SB/ctl/pid" 2>/dev/null || echo 100) + 1 )); echo $n > "$SB/ctl/pid"; echo $n
    else echo 100; fi ;;
esac
exit 0
EOF
  # curl: the checker answers from the checked-out code. repo/mode.txt = "broken" makes
  # /feeds/new 500; ctl/primary overrides what /health/latency reports.
  stub curl "$SB/bin" <<'EOF'
url=; wfmt=
while [ $# -gt 0 ]; do
  case "$1" in -w) wfmt=$2; shift ;; -o|--max-time) shift ;; http://*) url=$1 ;; esac; shift
done
path=${url#http://127.0.0.1:3131}
[ -f "$SB/ctl/stopped" ] && { [ -n "$wfmt" ] && printf 000; exit 7; }
mode=$(cat "$SB/repo/mode.txt" 2>/dev/null || echo ok)
primary=$(cat "$SB/ctl/primary" 2>/dev/null || grep -oE 'EXPECT_PRIMARY=(true|false)' "$SB/checker-deploy.conf" | cut -d= -f2)
if [ "$path" = /health/latency ]; then
  printf '{"ok":true,"instance":"t","primary":%s,"db_ms":1.5}' "$primary"; exit 0
fi
code=200
[ "$mode" = broken ] && [ "${path%%\?*}" = /feeds/new ] && code=500
[ -n "$wfmt" ] && printf '%s' "$code"
exit 0
EOF
}

commit() {   # dir message [file content]...
  local d=$1 m=$2; shift 2
  while [ $# -gt 1 ]; do mkdir -p "$d/$(dirname "$1")"; printf '%s\n' "$2" > "$d/$1"; git -C "$d" add "$1"; shift 2; done
  git -C "$d" "${GIT_ID[@]}" commit -q -m "$m"
  git -C "$d" rev-parse HEAD
}

setup() {   # fresh sandbox: origin with 1 commit, checkout at it with the adServe patch
  SB=$(mktemp -d "$ROOT/sb.XXXX")
  mkdir -p "$SB/bin" "$SB/nodebin" "$SB/ctl" "$SB/state"
  git init -q -b main "$SB/work"
  BASE=$(commit "$SB/work" base server.js 'console.log(1)' routes/adServe.js 'module.exports = 1' mode.txt ok package-lock.json '{}')
  git clone -q --bare "$SB/work" "$SB/origin.git"
  git -C "$SB/work" remote add origin "$SB/origin.git"
  git clone -q "$SB/origin.git" "$SB/repo"
  printf 'module.exports = 2 // caps-off\n' > "$SB/repo/routes/adServe.js"
  cat > "$SB/checker-deploy.conf" <<EOF
NAME=test
REPO=$SB/repo
UNIT=test-checker
RUN_AS=$(id -un)
NODE_BIN=$SB/nodebin
PORT=3131
EXPECT_PRIMARY=${1:-true}
ALLOWED_LOCAL="routes/adServe.js"
EOF
  make_stubs; patch_script
}
push() { git -C "$SB/work" push -q origin main; }   # publish work's main
run() { OUT=$("$SB/deploy" "$@" 2>&1); RC=$?; }
head_of() { git -C "$SB/repo" rev-parse HEAD; }
calls() { cat "$SB/calls.log" 2>/dev/null; }
want() { [ -z "$ONLY" ] || [[ "$1" == *"$ONLY"* ]]; }

if want args; then t args; setup
  run deploy abc; assert_eq "$RC" 2 "short sha refused"
  run rm "$BASE"; assert_eq "$RC" 2 "unknown verb refused"
  run deploy "$(tr a-f A-F <<<"$BASE")"; assert_eq "$RC" 2 "uppercase sha refused"
fi

if want happy; then t happy; setup
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)'); push
  run deploy "$NEW"
  assert_eq "$RC" 0 "deploy succeeds"
  assert_eq "$(head_of)" "$NEW" "checkout is at the new commit"
  assert_contains "$(cat "$SB/repo/routes/adServe.js")" "caps-off" "local adServe patch survives"
  assert_contains "$(calls)" "systemctl restart test-checker" "unit restarted"
  assert_not_contains "$(calls)" "npm" "no npm ci without package changes"
  assert_eq "$(cat "$SB/state/deployed_sha")" "$NEW" "state records the commit"
  assert_contains "$(cat "$SB/deploy.log")" "deployed ${NEW:0:8} OK" "logged"
fi

if want exact; then t exact-not-tip; setup
  A=$(commit "$SB/work" a server.js 'console.log(2)'); B=$(commit "$SB/work" b server.js 'console.log(3)'); push
  run deploy "$A"
  assert_eq "$RC" 0 "deploy of a non-tip commit succeeds"
  assert_eq "$(head_of)" "$A" "exactly that commit, not the newer untested tip"
fi

if want offmain; then t offmain; setup
  git -C "$SB/work" checkout -q -b side
  S=$(commit "$SB/work" side server.js 'console.log(9)'); git -C "$SB/work" push -q origin side
  run deploy "$S"
  assert_eq "$RC" 1 "commit not on main refused"
  assert_contains "$OUT" "is not on origin/main" "reason given"
  assert_eq "$(head_of)" "$BASE" "checkout untouched"
  assert_not_contains "$(calls)" "restart" "no restart"
fi

if want already; then t already-and-older; setup
  run deploy "$BASE"
  assert_eq "$RC" 0 "redeploying the running commit is a no-op"
  assert_not_contains "$(calls)" "restart" "no restart"
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)'); push
  run deploy "$NEW"; : > "$SB/calls.log"
  run deploy "$BASE"
  assert_eq "$RC" 0 "an older commit is a no-op (never goes backwards)"
  assert_eq "$(head_of)" "$NEW" "still on the newer commit"
  assert_not_contains "$(calls)" "restart" "no restart"
fi

if want conflict; then t patch-conflict; setup
  NEW=$(commit "$SB/work" upstream-adserve routes/adServe.js 'module.exports = 3'); push
  run deploy "$NEW"
  assert_eq "$RC" 1 "refused when upstream changes a locally patched file"
  assert_contains "$OUT" "upstream changed routes/adServe.js" "reason given"
  assert_eq "$(head_of)" "$BASE" "checkout untouched"
  assert_contains "$(cat "$SB/repo/routes/adServe.js")" "caps-off" "patch untouched"
  assert_not_contains "$(calls)" "restart" "no restart"
fi

if want dirty; then t dirty; setup
  echo 'console.log("hand edit")' > "$SB/repo/server.js"
  NEW=$(commit "$SB/work" feat mode.txt ok2); push
  run deploy "$NEW"
  assert_eq "$RC" 1 "an edit outside ALLOWED_LOCAL is refused"
  assert_contains "$OUT" "local edit to tracked file server.js" "reason given"
  assert_eq "$(head_of)" "$BASE" "checkout untouched"
fi

if want syntax; then t syntax; setup
  NEW=$(commit "$SB/work" broken-js server.js 'function ( {'); push
  run deploy "$NEW"
  assert_eq "$RC" 1 "a syntax error is refused"
  assert_contains "$OUT" "syntax error in server.js" "reason given"
  assert_eq "$(head_of)" "$BASE" "refused before touching the checkout"
  assert_not_contains "$(calls)" "restart" "no restart"
fi

if want check; then t check; setup
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)' package-lock.json '{"x":1}'); push
  run check "$NEW"
  assert_eq "$RC" 0 "check passes"
  assert_contains "$OUT" "npm ci: yes" "check reports the npm ci"
  assert_eq "$(head_of)" "$BASE" "check changes nothing"
  assert_not_contains "$(calls)" "restart" "no restart"
  assert_not_contains "$(calls)" "npm ci" "no npm"
fi

if want deps; then t deps; setup
  NEW=$(commit "$SB/work" deps package-lock.json '{"x":1}'); push
  run deploy "$NEW"
  assert_eq "$RC" 0 "deploy with a lockfile change succeeds"
  assert_contains "$(calls)" "npm ci --omit=dev" "npm ci ran"
fi

if want rollback; then t rollback-unhealthy; setup
  NEW=$(commit "$SB/work" breaks-feeds mode.txt broken); push
  run deploy "$NEW"
  assert_eq "$RC" 1 "an unhealthy deploy fails"
  assert_contains "$OUT" "/feeds/new" "the failing route is named"
  assert_eq "$(head_of)" "$BASE" "rolled back to the old commit"
  assert_contains "$(cat "$SB/repo/routes/adServe.js")" "caps-off" "patch survives the rollback"
  assert_eq "$(grep -c 'systemctl restart' "$SB/calls.log")" 2 "restarted for the deploy and again for the rollback"
  assert_eq "$(cat "$SB/state/deployed_sha")" "$BASE" "state = old commit"
  assert_contains "$OUT" "healthy again" "old code healthy again"
fi

if want rollback; then t rollback-npm; setup
  NEW=$(commit "$SB/work" deps package-lock.json '{"x":1}'); push
  touch "$SB/ctl/npm_fail"
  run deploy "$NEW"
  assert_eq "$RC" 1 "a failed npm ci fails the deploy"
  assert_eq "$(head_of)" "$BASE" "rolled back"
fi

if want rollback; then t rollback-crashloop; setup
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)'); push
  touch "$SB/ctl/crashloop"
  run deploy "$NEW"
  assert_eq "$RC" 1 "a unit that restarts right after answering fails the deploy"
  assert_contains "$OUT" "restarted or died" "reason given"
  assert_eq "$(head_of)" "$BASE" "rolled back"
fi

if want replica; then t replica-jobs-on; setup false
  echo true > "$SB/ctl/primary"
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)'); push
  run deploy "$NEW"
  assert_eq "$RC" 1 "a replica reporting primary:true fails"
  assert_contains "$(calls)" "systemctl stop test-checker" "the replica is STOPPED"
  assert_eq "$(tail -1 "$SB/calls.log" | grep -c 'systemctl restart')" 0 "and not restarted afterwards"
  assert_file "$SB/ctl/stopped" "still stopped"
  assert_eq "$(head_of)" "$BASE" "code reset to the old commit"
  assert_contains "$OUT" "STOPPED" "reason given"
fi

if want replica; then t replica-ok; setup false
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)'); push
  run deploy "$NEW"
  assert_eq "$RC" 0 "a replica reporting primary:false deploys"
fi

if want primary; then t primary-mismatch; setup true
  echo false > "$SB/ctl/primary"
  NEW=$(commit "$SB/work" feat server.js 'console.log(2)'); push
  run deploy "$NEW"
  assert_eq "$RC" 1 "the primary reporting primary:false fails (jobs would stop)"
  assert_not_contains "$(calls)" "systemctl stop" "the primary is not stopped"
  assert_eq "$(head_of)" "$BASE" "rolled back"
fi

if want conf; then t conf-is-data; setup
  echo 'EXPECT_PRIMARY=$(touch '"$SB"'/pwned)' >> "$SB/checker-deploy.conf"
  run check "$BASE"
  assert_no_file "$SB/pwned" "the conf is never executed"
  assert_eq "$RC" 2 "an invalid value is refused"
fi

finish
