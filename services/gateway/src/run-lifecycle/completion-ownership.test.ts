import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NativeWorkerSessionBinding } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import {
  getRuntimeCapabilityRegistry,
  hasHadTerminalCleanup,
} from '../methods/runtime-capabilities.js';
import { detachRunsForReleasedSlot } from '../methods/slot/release-run-ownership.js';
import {
  archiveRun,
  createRun,
  deleteRun,
  getRun,
  getRunWithArchived,
  listRuns,
  updateRun,
} from '../runs/store.js';

import { assertRunNotArchiving, isRunArchiving } from './archive-fence.js';

test('the production store retains failed completion for admission, eviction and runtime recovery', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'completion-ownership',
    ticketOrPr: 'OWNER-123',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    }
  });
  const held = updateRun(run.id, {
    status: 'failed',
    slotId: 'retained-slot',
    steps: [{ name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }],
  });
  assert.ok(listRuns({ active: true }).runs.some((entry) => entry.id === run.id));
  assert.equal(hasHadTerminalCleanup(held), false);
  await assert.rejects(deleteRun(run.id), /Cannot delete active run/);
  await assert.rejects(archiveRun(run.id), /Cannot archive active run/);
  updateRun(run.id, { status: 'done' });
  assert.equal(hasHadTerminalCleanup(getRun(run.id)!), true);
  assert.equal(
    listRuns({ active: true }).runs.some((entry) => entry.id === run.id),
    false,
  );
  assert.equal(await deleteRun(run.id), true);
});

for (const evict of [archiveRun, deleteRun]) {
  test(`${evict.name} permits failed completion only after explicit release and confirmed cleanup`, async (t) => {
    const run = createRun({
      flowType: 'dev',
      project: 'completion-ownership',
      ticketOrPr: `OWNER-${evict.name}`,
    });
    t.after(async () => {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'done', agentContexts: [] });
        await deleteRun(run.id);
      }
    });
    updateRun(run.id, {
      flowType: 'qa',
      status: 'failed',
      slotId: 'retained-slot',
      steps: [{ name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }],
      metrics: { ...run.metrics, outcome: 'partial' },
    });
    const steps = structuredClone(run.steps);
    await assert.rejects(evict(run.id), /release slot retained-slot first/);
    detachRunsForReleasedSlot('retained-slot', () => {}, run.id);
    assert.equal(run.slotId, null);
    const nativeSession: NativeWorkerSessionBinding = {
      sessionId: 'retained-session',
      executionNodeId: 'test-node',
      ownerPrincipalId: 'test-owner',
      leaseId: 'retained-lease',
      commandId: 'retained-command',
    };
    updateRun(run.id, {
      agentContexts: [
        {
          id: 'primary',
          role: 'primary',
          label: 'Primary',
          status: 'working',
          runId: run.id,
          slotId: 'retained-slot',
          nativeSession,
        },
      ],
    });
    await assert.rejects(evict(run.id), /before confirmed close or transfer/);
    nativeSession.closedAt = new Date().toISOString();
    let providerReleased = false;
    const check = mock.method(
      getRuntimeCapabilityRegistry(),
      'assertRunReleased',
      async (id: string) => {
        assert.equal(id, run.id);
        assert.equal(isRunArchiving(run.id), true);
        assert.throws(() => assertRunNotArchiving(run.id), /is being archived/);
        if (!providerReleased) throw new Error('Provider cleanup deferred');
      },
    );
    t.after(() => check.mock.restore());
    await assert.rejects(evict(run.id), /Provider cleanup deferred/);
    assert.equal(getRun(run.id)?.status, 'failed');
    assert.equal(isRunArchiving(run.id), false, 'refusal releases only the archive fence');
    providerReleased = true;
    assert.equal(await evict(run.id), true);
    assert.equal(getRun(run.id), undefined);
    assert.equal(isRunArchiving(run.id), false);
    if (evict === archiveRun) {
      const archived = await getRunWithArchived(run.id);
      assert.equal(archived?.status, 'failed');
      assert.equal(archived?.metrics.outcome, 'partial');
      assert.deepEqual(archived?.steps, steps);
    }
  });
}
