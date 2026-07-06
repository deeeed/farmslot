import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  CHECKLIST_TARGET_MANIFEST,
  checklistTargetForAgentRole,
  CI_FIX_CHECKLIST_TARGET,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  SELF_REVIEW_CHECKLIST_TARGET,
  SELF_REVIEW_FIX_CHECKLIST_TARGET,
  targetForChecklistBasename,
  taskDirRelPath,
  writeWorkerChecklistTargetLocal,
} from './checklist-target.js';

test('targetForChecklistBasename maps role checklists to sibling signal files', () => {
  assert.deepEqual(targetForChecklistBasename('SELF-REVIEW.md'), SELF_REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('CI-FIX.md'), CI_FIX_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('TASK.md'), {
    checklist: 'TASK.md',
    signal: 'SIGNAL.json',
  });
});

test('CHECKLIST_TARGET_BY_AGENT_ROLE exposes nested-loop role targets', () => {
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['self-review'], SELF_REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(
    CHECKLIST_TARGET_BY_AGENT_ROLE['self-review-fix'],
    SELF_REVIEW_FIX_CHECKLIST_TARGET,
  );
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

test('writeWorkerChecklistTargetLocal prefers CHECKLIST.md when present', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'checklist-target-'));
  writeFileSync(path.join(dir, 'TASK.md'), '# task\n', 'utf-8');
  writeFileSync(path.join(dir, 'CHECKLIST.md'), '# checklist\n', 'utf-8');
  await writeWorkerChecklistTargetLocal(dir);
  const manifest = JSON.parse(readFileSync(path.join(dir, CHECKLIST_TARGET_MANIFEST), 'utf-8'));
  assert.deepEqual(manifest, {
    checklist: 'CHECKLIST.md',
  });
});
