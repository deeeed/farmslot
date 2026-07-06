import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CHECKLIST_TARGET_MANIFEST,
  targetForChecklistBasename,
  writeWorkerChecklistTargetLocal,
} from './checklist-target.js';

test('targetForChecklistBasename maps role checklists to sibling signal files', () => {
  assert.deepEqual(targetForChecklistBasename('SELF-REVIEW.md'), {
    checklist: 'SELF-REVIEW.md',
    signal: 'SELF-REVIEW-SIGNAL.json',
  });
  assert.deepEqual(targetForChecklistBasename('CI-FIX.md'), {
    checklist: 'CI-FIX.md',
    signal: 'CI-FIX-SIGNAL.json',
  });
  assert.deepEqual(targetForChecklistBasename('TASK.md'), {
    checklist: 'TASK.md',
    signal: 'SIGNAL.json',
  });
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
