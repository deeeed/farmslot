#!/usr/bin/env bash
# smoke.sh — pack smoke check: every example-app slot repo runs the app.
# Env (set by project add): FARMSLOT_WORKSPACE, FARMSLOT_DIR, FARMSLOT_REPOS_DIR
set -euo pipefail

REPOS="${FARMSLOT_REPOS_DIR:?project add must set FARMSLOT_REPOS_DIR}"

found=0
for repo in "${REPOS}"/example-app-[0-9]*; do
  [ -d "${repo}/.git" ] || continue
  found=1
  out="$(cd "$repo" && node app.mjs)"
  if [ "$out" != "example-app ok" ]; then
    echo "FAIL: ${repo}: unexpected app output: ${out}"
    exit 1
  fi
  echo "PASS ${repo}: ${out}"
done

if [ "$found" = 0 ]; then
  echo "FAIL: no example-app slot repos found under ${REPOS}"
  exit 1
fi
