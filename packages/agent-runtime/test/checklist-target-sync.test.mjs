import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import * as protocol from '@farmslot/protocol/checklist-target';

const require = createRequire(import.meta.url);
const cjs = require('../scripts/checklist-target.cjs');

const SYNC_KEYS = [
  'CHECKLIST_SKIP_SECTIONS',
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

// Nasty fixture covering every skip rule: skip sections (ACs, pre-merge),
// <details> bodies, fenced code blocks, indented boxes, and phase headings.
const ENUMERATION_FIXTURE = [
  '# Worker: Feature — DEMO-9',
  '',
  '- [ ] Orphan step before any heading',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] Informational AC one',
  '- [x] Informational AC two',
  '',
  '## Checklist',
  '',
  '### Phase 1: Setup',
  '',
  '- [x] **1. First step** — done',
  '- [ ] **2. Second step**',
  '```bash',
  '- [ ] not a step (fenced)',
  '```',
  '  - [ ] Indented step three',
  '',
  '<details><summary>reference</summary>',
  '- [ ] not a step (details)',
  '</details>',
  '',
  '### Phase 2: Validate',
  '',
  '- [ ] Fourth step',
  '',
  '## Pre-merge author checklist',
  '',
  '- [ ] upstream PR-template box',
].join('\n');

test('checklist-target.cjs enumerateChecklistCheckboxes matches protocol behavior', () => {
  const fromProtocol = protocol.enumerateChecklistCheckboxes(ENUMERATION_FIXTURE);
  const fromCjs = cjs.enumerateChecklistCheckboxes(ENUMERATION_FIXTURE);
  assert.deepEqual(fromCjs, fromProtocol, 'enumeration drifted from protocol');
  assert.deepEqual(
    fromProtocol.map((item) => item.stepNumber),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    fromProtocol.map((item) => item.phase),
    [null, 'Phase 1: Setup', 'Phase 1: Setup', 'Phase 1: Setup', 'Phase 2: Validate'],
  );
  assert.deepEqual(
    fromProtocol.map((item) => item.checked),
    [false, true, false, false, false],
  );
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
