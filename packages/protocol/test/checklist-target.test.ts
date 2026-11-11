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
  enumerateChecklistCheckboxes,
  nestedLoopProgressLabel,
  REVIEW_CHECKLIST,
  REVIEW_CHECKLIST_TARGET,
  REVIEW_FIX_CHECKLIST,
  shouldAcceptTaskProgressUpdate,
  signalFileForChecklist,
  SUBTASK_ID_PATTERN,
  SUBTASK_INDEX_FILE,
  subtaskPaths,
  SUBTASKS_DIR,
  targetForChecklistBasename,
  taskProgressWithStepDetails,
  terminalContractInputForChecklist,
} from '../src/checklist-target.js';
import { isSettledSubtaskStatus, isTerminalWorkerSignalStatus } from '../src/transport/signal.js';

test('targetForChecklistBasename maps role checklists to sibling signal files', () => {
  assert.deepEqual(targetForChecklistBasename(REVIEW_CHECKLIST), REVIEW_CHECKLIST_TARGET);
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
    terminalContractInputForChecklist('REVIEW.rev-codex.md'),
    'inputs/worker-terminal-contract.REVIEW.rev-codex.json',
  );
});

test('agentRoleForChecklistBasename resolves nested-loop roles from registry', () => {
  assert.equal(agentRoleForChecklistBasename(REVIEW_CHECKLIST), 'review');
  assert.equal(agentRoleForChecklistBasename(REVIEW_FIX_CHECKLIST), 'review-fix');
  assert.equal(agentRoleForChecklistBasename(CI_FIX_CHECKLIST), 'ci-fix');
  assert.equal(agentRoleForChecklistBasename('TASK.md'), null);
});

test('shouldAcceptTaskProgressUpdate filters stale nested-loop progress', () => {
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      { taskFile: 'TASK.md', activeTaskFile: REVIEW_CHECKLIST },
      { contextId: 'review' },
    ),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      { taskFile: 'TASK.md', activeTaskFile: REVIEW_CHECKLIST },
      { contextId: 'worker' },
    ),
    false,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(
      { taskFile: 'TASK.md', activeTaskFile: REVIEW_FIX_CHECKLIST },
      { contextId: 'review' },
    ),
    false,
  );
});

test('nestedLoopProgressLabel uses active checklist basename', () => {
  assert.equal(nestedLoopProgressLabel('review', REVIEW_FIX_CHECKLIST), 'Review Fix Progress');
  assert.equal(nestedLoopProgressLabel('review', REVIEW_CHECKLIST), 'Review Progress');
  assert.equal(nestedLoopProgressLabel('ci-watch', CI_FIX_CHECKLIST), 'CI Fix Progress');
  assert.equal(nestedLoopProgressLabel('human-gate', 'REVIEW.rev-cursor.md'), 'Review Progress');
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
  const reviewRun = {
    taskFile: 'temp/tasks/dev/demo/TASK.md',
    activeTaskFile: `temp/tasks/dev/demo/${REVIEW_CHECKLIST}`,
  };
  const child = (parentChecklist: string) => ({
    role: 'subtask' as const,
    contextId: 'perps-review',
    parentChecklist,
  });

  // child parent CHECKLIST.md, active worker file → accept
  assert.equal(shouldAcceptTaskProgressUpdate(workerRun, child('CHECKLIST.md')), true);
  // child parent REVIEW.md, active REVIEW.md → accept
  assert.equal(shouldAcceptTaskProgressUpdate(reviewRun, child(REVIEW_CHECKLIST)), true);
  // child parent CHECKLIST.md, active REVIEW.md → reject
  assert.equal(shouldAcceptTaskProgressUpdate(reviewRun, child('CHECKLIST.md')), false);
  // child parent REVIEW.md, active worker file → reject
  assert.equal(shouldAcceptTaskProgressUpdate(workerRun, child(REVIEW_CHECKLIST)), false);

  // A child update with no parent link is never live.
  assert.equal(
    shouldAcceptTaskProgressUpdate(workerRun, { role: 'subtask', contextId: 'perps-review' }),
    false,
  );
  // Every other role keeps today's behaviour.
  assert.equal(shouldAcceptTaskProgressUpdate(reviewRun, { contextId: 'review' }), true);
  assert.equal(shouldAcceptTaskProgressUpdate(reviewRun, { contextId: 'worker' }), false);
});

test('checkbox detail is de-indented and bounded by the next step or section', () => {
  const rows = enumerateChecklistCheckboxes(
    [
      '## Work',
      '- [ ] 1. Read the task',
      '  Read the acceptance criteria.',
      '    Keep nested indentation.',
      '',
      '- [x] 2. Verify',
      '  Record the evidence.',
      '## Rules',
      'This section is not step detail.',
    ].join('\n'),
  );
  assert.deepEqual(
    rows.map(({ rawLabel, detail, checked }) => ({ rawLabel, detail, checked })),
    [
      {
        rawLabel: '1. Read the task',
        detail: 'Read the acceptance criteria.\n  Keep nested indentation.',
        checked: false,
      },
      { rawLabel: '2. Verify', detail: 'Record the evidence.', checked: true },
    ],
  );
  assert.deepEqual(
    rows.map(({ stepNumber }) => stepNumber),
    [1, 2],
  );
});

test('fenced example checkboxes and headings stay inside detail without becoming steps', () => {
  const rows = enumerateChecklistCheckboxes(
    [
      '## Work',
      '- [ ] 1. Inspect',
      '  Example:',
      '  ```md',
      '  - [ ] not a real step',
      '  ## not a boundary',
      '  ```',
      '  Then inspect the actual source.',
      '- [ ] 2. Finish',
      '',
    ].join('\n'),
  );
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].detail,
    'Example:\n```md\n- [ ] not a real step\n## not a boundary\n```\nThen inspect the actual source.',
  );
  assert.equal(Object.hasOwn(rows[1], 'detail'), false);
});

test('detail trims only blank edges and normalizes CRLF without changing step targeting', () => {
  const rows = enumerateChecklistCheckboxes(
    '## Work\r\n- [ ] 1. Inspect\r\n\r\n  Keep trailing spaces.  \r\n\r\n- [ ] 2. Done\r\n',
  );
  assert.equal(rows[0].detail, 'Keep trailing spaces.  ');
  assert.deepEqual(
    rows.map(({ stepNumber, lineIndex }) => ({ stepNumber, lineIndex })),
    [
      { stepNumber: 1, lineIndex: 1 },
      { stepNumber: 2, lineIndex: 5 },
    ],
  );
});

test('legacy progress detail enrichment leaves its original completion data untouched', () => {
  const step = { index: 1, name: 'Inspect', status: 'done' as const };
  const progress = {
    schema: {
      flowType: 'dev',
      title: 'Task',
      totalSteps: 1,
      phases: [{ name: 'Work', steps: [step] }],
    },
    phases: [{ name: 'Work', steps: [step], completedSteps: 1, totalSteps: 1 }],
    completedSteps: 1,
    totalSteps: 1,
    currentPhase: null,
    currentStep: null,
  };
  const view = taskProgressWithStepDetails(
    progress,
    '## Work\n- [x] Inspect\n  Read the source.\n',
  );
  assert.equal(view?.phases[0].steps[0].detail, 'Read the source.');
  assert.equal(view?.phases[0].steps[0].status, 'done');
  assert.equal(Object.hasOwn(step, 'detail'), false);
  assert.equal(view?.completedSteps, 1);
});
