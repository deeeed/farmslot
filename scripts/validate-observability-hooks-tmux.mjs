#!/usr/bin/env node
/** Thin wrapper — delegates to scripts/runner-validation/run.mjs --scenario hook-smoke */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = spawnSync(
  process.execPath,
  [path.join(ROOT, 'scripts/runner-validation/run.mjs'), '--scenario', 'hook-smoke', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(runner.status ?? 1);