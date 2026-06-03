import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { refreshRunLinks } from './run-links.js';

test('refreshRunLinks labels review-pr ticket refs as PR links', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#123',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await refreshRunLinks(run.id);

  assert.deepEqual(getRun(run.id)?.links, [
    { label: 'PR', url: 'https://github.com/owner/repo/pull/123' },
  ]);
});
