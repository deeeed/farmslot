#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromHere = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveRuntimeScript() {
  try {
    return requireFromHere.resolve(
      '@farmslot/agent-runtime/scripts/check-task-artifact-contract.mjs',
    );
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return path.resolve(packageRoot, '../agent-runtime/scripts/check-task-artifact-contract.mjs');
  }
}

const result = spawnSync(process.execPath, [resolveRuntimeScript(), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
