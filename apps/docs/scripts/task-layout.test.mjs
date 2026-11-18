import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { taskLayoutDocIssues } from '../../../packages/protocol/scripts/check-task-layout-docs.mjs';

test('task-directory references name only paths defined by the protocol contract', async () => {
  for (const relative of [
    '../../../docs/reference/task-directory-contract.md',
    '../docs/reference/task-directory-contract.md',
    '../../../docs/reference/recipe-runtime-capability-contract.md',
    '../../../docs/plans/farmslot-cross-surface-evidence-e2e-goal.md',
  ]) {
    const document = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.deepEqual(taskLayoutDocIssues(document), [], relative);
  }
});

test('source-document mutations of gateway artifact and input paths fail the shared check', async () => {
  const document = await readFile(
    new URL('../../../docs/reference/task-directory-contract.md', import.meta.url),
    'utf8',
  );
  for (const known of ['artifacts/diff.txt', 'inputs/runtime-capability-catalog.json']) {
    const unknown = known.replace('/', '/not-in-contract-');
    const changed = document.replaceAll(known, unknown);
    assert.ok(
      changed !== document,
      `The source must spell its task-relative path explicitly: ${known}`,
    );
    assert.ok(
      taskLayoutDocIssues(changed).some(({ relativePath }) => relativePath === unknown),
      unknown,
    );
  }
});
