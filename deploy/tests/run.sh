#!/usr/bin/env bash
# Every checker deploy test (sandbox only; changes nothing on the box).
HERE="$(cd "$(dirname "$0")" && pwd)"
rc=0
bash "$HERE/test-entry.sh" || rc=1
bash "$HERE/test-deploy.sh" || rc=1
exit $rc
