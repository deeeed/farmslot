import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { continueResolvedRunDecision } = await import('../run.js');

for (const consumed of [false, true]) {
  test(`a ${consumed ? 'consumed' : 'resolved'} publication review request ${consumed ? 'does not resume' : 'resumes'} a reconciling gate`, async (t) => {
    const run = createRun({
      flowType: 'dev',
      mode: 'autonomous',
      project: 'gate-restart',
      ticketOrPr: 'GATE-REVIEW-RECONCILING',
    });
    const decision: RunDecision = {
      id: `reconciling-review-${run.id}`,
      type: 'engine_human_gate',
      title: 'Publication gate',
      description: 'Review the retained package.',
      createdAt: '2026-10-22T14:16:31.017Z',
      resolvedAt: '2026-10-22T14:26:43.151Z',
      resolvedAction: 'request-review',
      ...(consumed ? { context: { reviewRequestConsumedAt: '2026-10-22T14:26:44.151Z' } } : {}),
      actions: [{ id: 'request-review', label: 'Request Review', style: 'secondary' }],
      selectionData: {
        reviewRequest: { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
      },
    };
    updateRun(run.id, {
      status: 'reconciling',
      engineState: { generation: 2 },
      decisions: [decision],
      steps: [
        { name: 'complete', status: 'done', outputs: { packageId: 'retained-package' } },
        { name: 'human-gate', status: 'skipped' },
        { name: 'finalize', status: 'skipped' },
      ],
    });
    t.after(async () => {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    });
    let resumes = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    continueResolvedRunDecision(
      { runId: run.id, decisionId: decision.id, actionId: 'request-review' },
      () => {},
      {
        resumeRun: async () => {
          resumes++;
        },
      },
      2,
    );
    t.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resumes, consumed ? 0 : 1);
    assert.equal(getRun(run.id)!.status, consumed ? 'reconciling' : 'created');
    assert.equal(getRun(run.id)!.steps[0].outputs?.packageId, 'retained-package');
    assert.deepEqual(getRun(run.id)!.decisions, [decision]);
  });
}
