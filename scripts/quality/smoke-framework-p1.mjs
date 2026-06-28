#!/usr/bin/env node
/**
 * P1 smoke proof for #122 framework fixes (post PR #135).
 * Runs targeted unit tests + dispatch-comparison-family payload guard.
 *
 * Usage: yarn smoke:framework-p1
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function run(label, command, args) {
  process.stdout.write(`\n[smoke-p1] ${label}\n`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`[smoke-p1] FAILED: ${label}\n`);
    process.exit(result.status ?? 1);
  }
}

const gatewayTests = [
  'src/methods/slot/fixtures.test.ts',
  'src/methods/run/comparison-branch-policy.test.ts',
  'src/runners/registry.test.ts',
  'src/run-engine/engine-decisions.test.ts',
  'src/projects/start-ref-policy.test.ts',
];

for (const file of gatewayTests) {
  run(`gateway test ${file}`, 'yarn', [
    'workspace',
    '@farmslot/gateway',
    'exec',
    'node',
    '--import',
    'tsx',
    '--test',
    file,
  ]);
}

const familyScript = join(repoRoot, 'scripts/dispatch-comparison-family.mjs');
const familySrc = await readFile(familyScript, 'utf8');
if (!familySrc.includes('runner,')) {
  process.stderr.write(
    '[smoke-p1] FAILED: dispatch-comparison-family must pass runner in run.create payload\n',
  );
  process.exit(1);
}
process.stdout.write('\n[smoke-p1] dispatch-comparison-family runner payload guard OK\n');

process.stdout.write('\n[smoke-p1] all P1 framework smoke checks passed\n');
