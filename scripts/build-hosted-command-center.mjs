#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDist = resolve(repoRoot, 'apps/command-center/ui/dist');
const docsBuild = resolve(repoRoot, 'apps/docs/build');
const ccTarget = resolve(docsBuild, 'cc');

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('yarn', ['--cwd', 'apps/command-center/ui', 'build'], { FARMSLOT_CC_BASE: '/cc/' });

if (!existsSync(docsBuild)) {
  console.error('apps/docs/build missing — run `yarn docs:build` before this script');
  process.exit(1);
}
rmSync(ccTarget, { recursive: true, force: true });
cpSync(uiDist, ccTarget, { recursive: true });
console.log(`Command Center copied to ${ccTarget}`);
