import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  checklistTargetForAgentRole,
  CI_FIX_CHECKLIST_TARGET,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  REVIEW_CHECKLIST_TARGET,
  REVIEW_FIX_CHECKLIST_TARGET,
  targetForChecklistBasename,
  taskDirRelPath,
} from './checklist-target.js';

test('targetForChecklistBasename maps role checklists to sibling signal files', () => {
  assert.deepEqual(targetForChecklistBasename('REVIEW.md'), REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('CI-FIX.md'), CI_FIX_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('TASK.md'), {
    checklist: 'TASK.md',
    signal: 'SIGNAL.json',
  });
});

test('CHECKLIST_TARGET_BY_AGENT_ROLE exposes nested-loop role targets', () => {
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['review'], REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['review-fix'], REVIEW_FIX_CHECKLIST_TARGET);
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['ci-fix'], CI_FIX_CHECKLIST_TARGET);
  assert.deepEqual(
    checklistTargetForAgentRole('ci-fix'),
    DEFAULT_CHECKLIST_TARGET_REGISTRY.roles['ci-fix'],
  );
});

test('taskDirRelPath joins task dir and basename without double slashes', () => {
  assert.equal(taskDirRelPath('tasks/foo', 'SIGNAL.json'), 'tasks/foo/SIGNAL.json');
  assert.equal(taskDirRelPath('tasks/foo/', 'CI-FIX.md'), 'tasks/foo/CI-FIX.md');
});
