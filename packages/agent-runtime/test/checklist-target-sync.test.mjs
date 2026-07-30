import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import * as protocol from '@farmslot/protocol/checklist-target';

const require = createRequire(import.meta.url);
const cjs = require('../scripts/checklist-target.cjs');

const SYNC_KEYS = [
  'CHECKLIST_TARGET_MANIFEST',
  'TASK_PROGRESS_MARKDOWN',
  'INTERACTIVE_CHECKLIST_MARKDOWN',
  'WORKER_SIGNAL_FILE',
  'ROLE_SIGNAL_SUFFIX',
  'SELF_REVIEW_CHECKLIST',
  'SELF_REVIEW_FIX_CHECKLIST',
  'CI_FIX_CHECKLIST',
  'SELF_REVIEW_CHECKLIST_TARGET',
  'SELF_REVIEW_FIX_CHECKLIST_TARGET',
  'CI_FIX_CHECKLIST_TARGET',
  'CHECKLIST_TARGET_BY_AGENT_ROLE',
  'DEFAULT_CHECKLIST_TARGET_REGISTRY',
];

test('checklist-target.cjs stays aligned with @farmslot/protocol/checklist-target', () => {
  for (const key of SYNC_KEYS) {
    assert.deepEqual(cjs[key], protocol[key], `${key} drifted from protocol registry`);
  }
});

test('checklist-target.cjs helpers match protocol registry semantics', () => {
  assert.deepEqual(
    cjs.targetForChecklistBasename(protocol.SELF_REVIEW_CHECKLIST),
    protocol.targetForChecklistBasename(protocol.SELF_REVIEW_CHECKLIST),
  );
  assert.deepEqual(
    cjs.checklistTargetForAgentRole('ci-fix'),
    protocol.checklistTargetForAgentRole('ci-fix'),
  );
  assert.equal(
    cjs.terminalContractInputForChecklist('SELF-REVIEW.rev-codex.md'),
    protocol.terminalContractInputForChecklist('SELF-REVIEW.rev-codex.md'),
  );
});
