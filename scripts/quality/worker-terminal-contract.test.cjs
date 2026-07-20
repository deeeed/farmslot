const assert = require('node:assert/strict');
const {
  resolveWorkerTerminalContract,
  lintWorkerTemplateAgainstContract,
  lintWorkerTemplateStructure,
  expandedArtifactsForCommand,
  templateTerminalCommands,
  templateUsesTerminalMark,
} = require('./worker-terminal-contract.cjs');

const devContract = resolveWorkerTerminalContract(null, 'dev');
assert.equal(devContract.requireSignal, true);
assert.deepEqual(devContract.commands.complete.artifacts, [
  'artifacts/learnings.md',
  'artifacts/pr-description.md',
]);
assert.equal(devContract.commands.complete.report, 'artifacts/pr-description.md');

const interactivePrComplete = resolveWorkerTerminalContract(null, 'pr-complete', {
  mode: 'interactive',
});
assert.equal(interactivePrComplete.requireSignal, false);

const projectContract = resolveWorkerTerminalContract(
  {
    flows: {
      dev: {
        complete: { report: 'artifacts/report.md', artifacts: ['artifacts/custom.md'] },
      },
    },
  },
  'dev',
);
assert.deepEqual(projectContract.commands.complete.artifacts, [
  'artifacts/report.md',
  'artifacts/custom.md',
]);

const templateOk = [
  '# Worker: Dev',
  '- [ ] Write `artifacts/learnings.md`',
  '- [ ] Write `artifacts/pr-description.md`',
  '- [ ] Run `./mark complete --mark-last`',
].join('\n');
assert.deepEqual(lintWorkerTemplateAgainstContract(templateOk, devContract), []);

const checklistOverrideTemplate = [
  '# Worker: CI Fix Pass',
  '- [ ] Write `artifacts/learnings.md`',
  '- [ ] Write `artifacts/report.md`',
  '- [ ] Write `artifacts/no-change-report.md` when no change is needed',
  '- [ ] Run `{{TASK_DIR}}/mark --checklist CI-FIX.md complete --mark-last`',
  '- [ ] Or run `{{TASK_DIR}}/mark --checklist CI-FIX.md no-change --reason "already fixed"`',
].join('\n');
assert.equal(templateUsesTerminalMark(checklistOverrideTemplate), true);
assert.deepEqual(templateTerminalCommands(checklistOverrideTemplate), ['complete', 'no-change']);
assert.deepEqual(
  lintWorkerTemplateAgainstContract(
    checklistOverrideTemplate,
    resolveWorkerTerminalContract(null, 'ci-fix'),
  ),
  [],
);

const templateBad = ['# Worker', '- [ ] Done'].join('\n');
assert.match(
  lintWorkerTemplateAgainstContract(templateBad, devContract)[0],
  /requireSignal is true but template has no terminal/,
);

const expanded = expandedArtifactsForCommand(
  devContract,
  'complete',
  (rel) => rel === 'artifacts/recipe.json',
);
assert.equal(expanded.requireRecipeQuality, true);
assert.ok(expanded.artifacts.includes('artifacts/recipe-coverage.md'));

const structureBad = [
  '# Worker',
  '## Task',
  'TASK_DIR: {{TASK_DIR}}',
  '## Checklist',
  '- [ ] **1. One**',
  '- [ ] **1. Duplicate**',
  '- [ ] Write `{TASK_DIR}/artifacts/learnings.md`',
  '- [ ] `{{TASK_DIR}}/mark complete --mark-last`',
].join('\n');
assert.match(
  lintWorkerTemplateStructure(structureBad).join(' '),
  /duplicate checklist step number/,
);
assert.match(lintWorkerTemplateStructure(structureBad).join(' '), /double braces/);

// A template that omits `./mark` entirely must fail lint when the contract
// requires a terminal signal, and pass when it does not (pr-complete interactive).
const marklessTemplate = ['# Worker: Dev — DEV-123', '- [ ] Do the work'].join('\n');
assert.deepEqual(lintWorkerTemplateAgainstContract(marklessTemplate, devContract), [
  'requireSignal is true but template has no terminal `./mark` or mark-checklist-step command',
]);
const interactivePrCompleteContract = resolveWorkerTerminalContract(null, 'pr-complete', {
  mode: 'interactive',
});
assert.equal(interactivePrCompleteContract.requireSignal, false);
assert.deepEqual(
  lintWorkerTemplateAgainstContract(marklessTemplate, interactivePrCompleteContract),
  [],
);

console.log('worker-terminal-contract: ok');
