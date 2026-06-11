#!/usr/bin/env bash
# pre-add.sh — seed the tiny product fixture repo this pack's slots clone from.
# Runs before `farmslot project add` clones product repos.
# Env (set by project add): FARMSLOT_WORKSPACE, FARMSLOT_DIR, FARMSLOT_REPOS_DIR
set -euo pipefail

SRC="${FARMSLOT_REPOS_DIR:?project add must set FARMSLOT_REPOS_DIR}/example-app-src"

if [ -d "${SRC}/.git" ]; then
  echo "fixture repo exists: ${SRC}"
  exit 0
fi

mkdir -p "${SRC}/scripts"

cat > "${SRC}/app.mjs" <<'EOF'
// example-app — tiny CLI app used to validate farmslot onboarding end to end.
console.log('example-app ok');
EOF

cat > "${SRC}/scripts/build.mjs" <<'EOF'
// build.mjs — fake preflight build: stamps the health file the project
// health_check hook reads. Accepts --port <n> like a real dev-server build.
import { mkdirSync, writeFileSync } from 'node:fs';

const portFlag = process.argv.indexOf('--port');
const port = portFlag >= 0 ? process.argv[portFlag + 1] : '0';
mkdirSync('.agent', { recursive: true });
writeFileSync('.agent/health', `port=${port}\nready\n`);
console.log(`example-app build complete (port ${port})`);
EOF

cat > "${SRC}/package.json" <<'EOF'
{
  "name": "example-app",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
EOF

cat > "${SRC}/.gitignore" <<'EOF'
.agent/
EOF

git -C "$SRC" init --quiet --initial-branch=main
git -C "$SRC" -c user.name=farmslot -c user.email=farmslot@localhost add -A
git -C "$SRC" -c user.name=farmslot -c user.email=farmslot@localhost commit --quiet -m "chore: seed example-app fixture repo"
echo "seeded fixture repo: ${SRC}"
