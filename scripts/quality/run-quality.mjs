#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const STEPS = [
  ['format', ['yarn', 'format:check']],
  ['lint', ['yarn', 'lint']],
  ['workspace structure', ['yarn', 'quality:structure']],
  ['workspace changelogs', ['yarn', 'quality:changelogs']],
  ['import boundaries', ['yarn', 'quality:imports']],
  ['large-file warning', ['yarn', 'quality:large-files']],
  ['type-escape lint', ['yarn', 'lint:type-escapes']],
  ['package/service workspace quality', ['yarn', 'quality:workspaces']],
  ['theme quality', ['yarn', 'workspace', '@farmslot/theme', 'quality']],
  ['recipe harness quality', ['yarn', 'workspace', '@farmslot/recipe-harness', 'quality']],
  ['protocol tests', ['yarn', 'test:protocol']],
  ['worker template contract', ['node', 'scripts/quality/worker-terminal-contract.test.cjs']],
  [
    'conventional commit guard tests',
    ['node', '--test', 'scripts/quality/check-conventional-commits.test.mjs'],
  ],
  [
    'single-canonical worker scripts',
    ['node', '--test', 'scripts/quality/single-canonical-worker-scripts.test.mjs'],
  ],
  ['worker template lint', ['node', 'scripts/quality/check-worker-template-contract.mjs']],
  ['template variable docs', ['node', 'scripts/quality/check-template-variables-docs.mjs']],
  ['shell script tests', ['bash', 'scripts/tests/run-shell-tests.sh']],
  ['project hook conformance tests', ['yarn', 'test:project-hooks']],
  ['recipe harness tests', ['yarn', 'test:recipe-harness']],
  ['ui tests', ['yarn', 'test:ui']],
  ['recipe operational gates', ['yarn', 'test:recipe-operational-gates']],
  ['companion tests', ['yarn', '--cwd', 'apps/companion', 'test:lib']],
  ['typecheck', ['yarn', 'typecheck']],
  ['package readiness', ['yarn', 'packages:publish:check']],
  ['docs build', ['yarn', 'docs:build']],
];

for (const [label, command] of STEPS) {
  console.log(`\n[quality] ${label}: ${command.join(' ')}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
