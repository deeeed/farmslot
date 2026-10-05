import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskDocument } from './task-document.js';

const baseInput = {
  flowType: 'dev',
  modePreamble: '> Autonomous execution: complete the authorized work.',
  vars: { TASK_DIR: 'temp/tasks/feat/t-1', TICKET: 'T-1', TITLE: 'Add a banner' },
  description: 'Show a banner.',
  acceptanceCriteria: ['The banner shows'],
  hasTicketData: false,
};

test('a run contract renders as the last section, after Inputs', () => {
  const contract = '## Run contract\n\n- Never pause for input.';
  const document = buildTaskDocument({ ...baseInput, runContract: contract });
  const withoutContract = buildTaskDocument(baseInput);

  assert.ok(document.endsWith(`${contract}\n`));
  assert.ok(document.indexOf('## Inputs') < document.indexOf('## Run contract'));
  // Every other section is byte for byte the same as a document without the contract.
  assert.equal(document.replace(`\n\n${contract}`, ''), withoutContract);
});

test('no run contract leaves the document unchanged', () => {
  assert.equal(
    buildTaskDocument({ ...baseInput, runContract: null }),
    buildTaskDocument(baseInput),
  );
  assert.equal(
    buildTaskDocument({ ...baseInput, runContract: '  ' }),
    buildTaskDocument(baseInput),
  );
  assert.doesNotMatch(buildTaskDocument(baseInput), /## Run contract/);
});
