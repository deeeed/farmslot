import assert from 'node:assert/strict';
import test from 'node:test';

import { farmslotRoot } from '../fleet/state.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { expandSelfReviewTemplate } from './templates.js';

test('expandSelfReviewTemplate resolves farmslot_dir placeholders', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'TEST-FARMSLOT-DIR',
    runner: 'claude',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  const rendered = await expandSelfReviewTemplate(
    {
      slotId: 'slot-1',
      projectName: 'farmslot-farm',
      remoteRepo: '/tmp/farmslot',
      platform: 'ios',
      session: 'slot-1',
      resourceVars: { port: '8061', cdpPort: '9222' },
    } as never,
    'temp/tasks/test/self-review',
    run.id,
    'full-live',
  );

  assert.equal(rendered.includes('{{farmslot_dir}}'), false);
  assert.equal(rendered.includes('{{FARMSLOT_DIR}}'), false);
  assert.match(
    rendered,
    new RegExp(
      `${farmslotRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/quality/check-task-artifact-contract\\.mjs`,
    ),
  );
});
