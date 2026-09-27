import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  resolveWorkerTerminalContract,
  withTerminalReportPath,
} from './worker-terminal-contract.js';

test('Farmslot Farm keeps gateway quality separate from worker evidence', () => {
  const project = JSON.parse(
    readFileSync(
      new URL('../../../../projects/farmslot-farm/project.json', import.meta.url),
      'utf8',
    ),
  );
  const contract = resolveWorkerTerminalContract(project.worker_terminal, 'fix-bug');
  assert.equal(contract.whenPresent.length, 1);
  assert.equal(contract.whenPresent[0].path, 'artifacts/recipe.json');
  assert.notEqual(contract.whenPresent[0].requireRecipeQuality, true);
  assert.equal(contract.whenPresent[0].requireRecipeCoverage, true);
  assert.deepEqual(contract.whenPresent[0].alsoRequire, [
    'artifacts/recipe-coverage.md',
    'artifacts/evidence-manifest.json',
  ]);
  assert.equal(contract.requireSignal, true);
  assert.deepEqual(contract.acceptance, { require: true });
});

test('resolver preserves explicit worker-authored quality requirements', () => {
  const config = {
    acceptance: { require: true },
    whenPresent: [
      {
        path: 'artifacts/recipe.json',
        alsoRequire: ['artifacts/recipe-coverage.md', 'artifacts/evidence-manifest.json'],
        requireRecipeQuality: true,
        requireRecipeCoverage: true,
      },
    ],
  };
  const contract = resolveWorkerTerminalContract(config, 'dev');
  assert.equal(contract.whenPresent[0].requireRecipeQuality, true);
  assert.equal(contract.whenPresent[0].requireRecipeCoverage, true);
  assert.deepEqual(contract.whenPresent[0].alsoRequire, config.whenPresent[0].alsoRequire);
  assert.deepEqual(contract.acceptance, { require: true });
  assert.equal(config.whenPresent[0].requireRecipeQuality, true);
});

test('builtin contracts retain worker-authored recipe quality support', () => {
  const contract = resolveWorkerTerminalContract(undefined, 'dev');
  assert.equal(contract.whenPresent[0].requireRecipeQuality, true);
});

test('withTerminalReportPath scopes reviewer completion artifacts to its context', () => {
  const base = resolveWorkerTerminalContract(undefined, 'self-review');
  const scoped = withTerminalReportPath(base, 'artifacts/review-feedback.rev8-claude.md');

  for (const command of ['complete', 'no-change'] as const) {
    assert.equal(scoped.commands[command].report, 'artifacts/review-feedback.rev8-claude.md');
    assert.deepEqual(scoped.commands[command].artifacts, [
      'artifacts/review-feedback.rev8-claude.md',
    ]);
  }
  assert.equal(base.commands.complete.report, 'artifacts/review-feedback.md');
});
