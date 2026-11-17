import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { taskLayoutDocIssues } from '../../../packages/protocol/scripts/check-task-layout-docs.mjs';

test('task-directory references name only paths defined by the protocol contract', async () => {
  for (const relative of [
    '../../../docs/reference/task-directory-contract.md',
    '../docs/reference/task-directory-contract.md',
  ]) {
    const document = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.deepEqual(taskLayoutDocIssues(document), [], relative);
  }
});
