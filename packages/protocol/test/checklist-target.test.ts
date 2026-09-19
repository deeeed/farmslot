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
  SUBTASK_ID_PATTERN,
  SUBTASK_INDEX_FILE,
  subtaskPaths,
  SUBTASKS_DIR,
  targetForChecklistBasename,
  terminalContractInputForChecklist,
} from '../src/checklist-target.js';
import { isSettledSubtaskStatus, isTerminalWorkerSignalStatus } from '../src/transport/signal.js';

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

test('subtaskPaths derives the child pair under subtasks/', () => {
  assert.equal(SUBTASKS_DIR, 'subtasks');
  assert.equal(SUBTASK_INDEX_FILE, 'index.json');
  assert.deepEqual(subtaskPaths('perps-review'), {
    checklist: 'subtasks/perps-review.md',
    signal: 'subtasks/perps-review-SIGNAL.json',
  });
});

test('SUBTASK_ID_PATTERN accepts slugs only', () => {
  for (const id of ['perps-review', 'a', 'step-21-review', '2fa-check']) {
    assert.ok(SUBTASK_ID_PATTERN.test(id), id);
  }
  for (const id of ['Perps', 'perps review', 'perps_review', '../escape', '']) {
    assert.ok(!SUBTASK_ID_PATTERN.test(id), id);
  }
});

test('isSettledSubtaskStatus is not the terminal predicate', () => {
  assert.equal(isSettledSubtaskStatus('complete'), true);
  assert.equal(isSettledSubtaskStatus('done'), true);
  assert.equal(isSettledSubtaskStatus('running'), false);
  // A blocked child stops the run yet keeps ownership of its parent step.
  assert.equal(isSettledSubtaskStatus('blocked'), false);
  assert.equal(isTerminalWorkerSignalStatus('blocked'), true);
  assert.equal(isSettledSubtaskStatus('failed'), false);
  assert.equal(isSettledSubtaskStatus('nonsense'), false);
  assert.equal(isSettledSubtaskStatus(null), false);
  assert.equal(isSettledSubtaskStatus(undefined), false);
});

test('shouldAcceptTaskProgressUpdate accepts a child only while its parent checklist is active', () => {
  const workerRun = { taskFile: 'temp/tasks/dev/demo/TASK.md', activeTaskFile: null };
  const selfReviewRun = {
    taskFile: 'temp/tasks/dev/demo/TASK.md',
    activeTaskFile: `temp/tasks/dev/demo/${SELF_REVIEW_CHECKLIST}`,
  };
  const child = (parentChecklist: string) => ({
    role: 'subtask' as const,
    contextId: 'perps-review',
    parentChecklist,
  });

  // child parent CHECKLIST.md, active worker file → accept
  assert.equal(shouldAcceptTaskProgressUpdate(workerRun, child('CHECKLIST.md')), true);
  // child parent SELF-REVIEW.md, active SELF-REVIEW.md → accept
  assert.equal(shouldAcceptTaskProgressUpdate(selfReviewRun, child(SELF_REVIEW_CHECKLIST)), true);
  // child parent CHECKLIST.md, active SELF-REVIEW.md → reject
  assert.equal(shouldAcceptTaskProgressUpdate(selfReviewRun, child('CHECKLIST.md')), false);
  // child parent SELF-REVIEW.md, active worker file → reject
  assert.equal(shouldAcceptTaskProgressUpdate(workerRun, child(SELF_REVIEW_CHECKLIST)), false);

  // A child update with no parent link is never live.
  assert.equal(
    shouldAcceptTaskProgressUpdate(workerRun, { role: 'subtask', contextId: 'perps-review' }),
    false,
  );
  // Every other role keeps today's behaviour.
  assert.equal(shouldAcceptTaskProgressUpdate(selfReviewRun, { contextId: 'self-review' }), true);
  assert.equal(shouldAcceptTaskProgressUpdate(selfReviewRun, { contextId: 'worker' }), false);
});
