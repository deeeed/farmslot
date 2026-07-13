#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const GATEWAY_GATE_TESTS = [
  'src/projects/schema.test.ts',
  'src/run-engine/project-fit-gate.test.ts',
  'src/methods/recipe.test.ts',
];

// Hook/template expansion moved to @farmslot/slot-config (Phase 2 extraction).
const SLOT_CONFIG_GATE_TESTS = ['src/hooks.test.ts'];

function run(command) {
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([
  'node',
  '../../scripts/quality/run-tsx-tests.mjs',
  '--cwd',
  '../../services/gateway',
  '--tsconfig',
  'tsconfig.json',
  ...GATEWAY_GATE_TESTS,
]);

run([
  'node',
  '../../scripts/quality/run-tsx-tests.mjs',
  '--cwd',
  '../../packages/slot-config',
  '--tsconfig',
  'tsconfig.json',
  ...SLOT_CONFIG_GATE_TESTS,
]);
run(['yarn', 'workspace', '@farmslot/cli', 'test']);
