import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentRoleForChecklistBasename,
  CHECKLIST_TARGET_BY_AGENT_ROLE,
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
});

test('checklistTargetForAgentRole reads from registry', () => {
  assert.deepEqual(checklistTargetForAgentRole('ci-fix'), CHECKLIST_TARGET_BY_AGENT_ROLE['ci-fix']);
});
