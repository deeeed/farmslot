const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  isScriptedCommandContract,
  resolveWorkerTerminalContract,
  SCRIPTED_COMMAND_RESULT,
} = require('../scripts/worker-terminal-contract.cjs');

// A pack that gates its agent workers: acceptance ledger, recipe evidence rules and
// project terminal artifacts. None of it applies to a run that has no worker.
const workerGatedProject = {
  acceptance: { require: true },
  complete: { report: 'artifacts/pr-description.md', artifacts: ['artifacts/learnings.md'] },
  whenPresent: [{ path: 'artifacts/recipe.json', alsoRequire: ['artifacts/recipe-run.json'] }],
};

test('a scripted-command contract is judged by the command result, not worker gates', () => {
  const contract = resolveWorkerTerminalContract(workerGatedProject, 'dev', {
    mode: 'autonomous',
    scriptedCommand: true,
  });
  assert.deepEqual(contract.scriptedCommand, { result: SCRIPTED_COMMAND_RESULT });
  assert.equal(SCRIPTED_COMMAND_RESULT, 'artifacts/scripted-command-result.json');
  assert.equal(contract.acceptance, undefined, 'no acceptance ledger without a worker');
  assert.deepEqual(contract.whenPresent, []);
  assert.deepEqual(contract.commands.complete, { artifacts: [SCRIPTED_COMMAND_RESULT] });
  assert.deepEqual(contract.commands.blocked, { artifacts: [] });
  assert.equal(isScriptedCommandContract(contract), true);
});

test('the default worker contract is unchanged and is not a scripted-command contract', () => {
  const contract = resolveWorkerTerminalContract(workerGatedProject, 'dev', { mode: 'autonomous' });
  assert.equal(contract.scriptedCommand, undefined);
  assert.deepEqual(contract.acceptance, { require: true });
  assert.equal(contract.commands.complete.report, 'artifacts/pr-description.md');
  assert.equal(isScriptedCommandContract(contract), false);
  assert.equal(isScriptedCommandContract(null), false);
  assert.equal(isScriptedCommandContract({ scriptedCommand: { result: 'other.json' } }), false);
});

test('a scripted command is not a proof measurement', () => {
  assert.throws(
    () =>
      resolveWorkerTerminalContract(null, 'qa', { proofMeasurement: true, scriptedCommand: true }),
    /scripted command/i,
  );
});
