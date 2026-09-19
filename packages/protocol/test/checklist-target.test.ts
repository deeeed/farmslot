import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentRoleForChecklistBasename,
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  checklistNumberingMismatches,
  checklistStepName,
  checklistTargetForAgentRole,
  CI_FIX_CHECKLIST,
  CI_FIX_CHECKLIST_TARGET,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  nestedLoopProgressLabel,
  SELF_REVIEW_CHECKLIST,
  SELF_REVIEW_CHECKLIST_TARGET,
  SELF_REVIEW_FIX_CHECKLIST,
  shouldAcceptTaskProgressUpdate,
  signalFileForChecklist,
  targetForChecklistBasename,
  terminalContractInputForChecklist,
} from '../src/checklist-target.js';

test('targetForChecklistBasename maps role checklists to sibling signal files', () => {
  assert.deepEqual(targetForChecklistBasename(SELF_REVIEW_CHECKLIST), SELF_REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename(CI_FIX_CHECKLIST), CI_FIX_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('TASK.md'), {
    checklist: 'TASK.md',
    signal: 'SIGNAL.json',
  });
});

test('signalFileForChecklist honors registry overrides', () => {
  const registry = {
    ...DEFAULT_CHECKLIST_TARGET_REGISTRY,
    workerTask: 'WORKER.md',
    interactiveChecklist: 'INTERACTIVE.md',
    workerSignal: 'WORKER-SIGNAL.json',
    roleSignalSuffix: '-PROGRESS.json',
  };
  assert.equal(signalFileForChecklist('WORKER.md', registry), 'WORKER-SIGNAL.json');
  assert.equal(signalFileForChecklist('CUSTOM-ROLE.md', registry), 'CUSTOM-ROLE-PROGRESS.json');
});

test('terminalContractInputForChecklist isolates nested agent contracts', () => {
  assert.equal(
    terminalContractInputForChecklist('TASK.md'),
    'inputs/worker-terminal-contract.json',
  );
  assert.equal(
    terminalContractInputForChecklist('CHECKLIST.md'),
    'inputs/worker-terminal-contract.json',
  );
  assert.equal(
    terminalContractInputForChecklist('SELF-REVIEW.rev-codex.md'),
    'inputs/worker-terminal-contract.SELF-REVIEW.rev-codex.json',
  );
});

test('agentRoleForChecklistBasename resolves nested-loop roles from registry', () => {
  assert.equal(agentRoleForChecklistBasename(SELF_REVIEW_CHECKLIST), 'self-review');
  assert.equal(agentRoleForChecklistBasename(SELF_REVIEW_FIX_CHECKLIST), 'self-review-fix');
  assert.equal(agentRoleForChecklistBasename(CI_FIX_CHECKLIST), 'ci-fix');
  assert.equal(agentRoleForChecklistBasename('TASK.md'), null);
});

test('shouldAcceptTaskProgressUpdate filters stale nested-loop progress', () => {
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      { taskFile: 'TASK.md', activeTaskFile: SELF_REVIEW_CHECKLIST },
      { contextId: 'self-review' },
    ),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      { taskFile: 'TASK.md', activeTaskFile: SELF_REVIEW_CHECKLIST },
      { contextId: 'worker' },
    ),
    false,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      { taskFile: 'TASK.md', activeTaskFile: SELF_REVIEW_FIX_CHECKLIST },
      { contextId: 'self-review' },
    ),
    false,
  );
});

test('nestedLoopProgressLabel uses active checklist basename', () => {
  assert.equal(
    nestedLoopProgressLabel('self-review', SELF_REVIEW_FIX_CHECKLIST),
    'Self-review Fix Progress',
  );
  assert.equal(
    nestedLoopProgressLabel('self-review', SELF_REVIEW_CHECKLIST),
    'Self-review Progress',
  );
  assert.equal(nestedLoopProgressLabel('ci-watch', CI_FIX_CHECKLIST), 'CI Fix Progress');
  assert.equal(
    nestedLoopProgressLabel('human-gate', 'SELF-REVIEW.rev-cursor.md'),
    'Independent Review Progress',
  );
});

test('checklistTargetForAgentRole reads from registry', () => {
  assert.deepEqual(checklistTargetForAgentRole('ci-fix'), CHECKLIST_TARGET_BY_AGENT_ROLE['ci-fix']);
});

test('checklistStepName keeps the bold lead, numbering included, and drops the instructions', () => {
  assert.equal(
    checklistStepName('**3. Resolve branch and PR number:** — `git branch --show-current`'),
    '3. Resolve branch and PR number:',
  );
  assert.equal(checklistStepName('**1. Confirm recipe tooling**'), '1. Confirm recipe tooling');
  // No bold lead: the raw label is the name.
  assert.equal(
    checklistStepName('  5. AC matrix — state/visual/mixed. '),
    '5. AC matrix — state/visual/mixed.',
  );
  assert.equal(
    checklistStepName('2. **Prompt/task captured** (summary + ACs).'),
    '2. **Prompt/task captured** (summary + ACs).',
  );
});

test('checklistNumberingMismatches flags labels that diverge from step positions', () => {
  const skewed = [
    '# Worker: Fix',
    '',
    '## Checklist',
    '',
    '- [ ] **1. First**',
    '- [ ] **1a. Sub-step without its own number**',
    '- [ ] **2. Now sits at position 3**',
  ].join('\n');
  // The suffixed label is itself reported, not just the drift it causes one row later.
  // `mark N` targets positions, so `1a` at position 2 is already the divergence; leaving
  // it unflagged is how an inserted step silently desynchronises a whole checklist.
  assert.deepEqual(checklistNumberingMismatches(skewed), [
    'position 2 is labeled "1a"',
    'position 3 is labeled "2"',
  ]);

  const aligned = [
    '## Checklist',
    '',
    '- [ ] **1. First**',
    '- [ ] Unnumbered box is fine',
    '- [ ] **3. Matches its position**',
  ].join('\n');
  assert.deepEqual(checklistNumberingMismatches(aligned), []);
});
