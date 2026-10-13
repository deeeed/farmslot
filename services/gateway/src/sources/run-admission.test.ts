import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';
import { currentProjectSources } from '@farmslot/slot-config';
import { sourceLockDigest } from '@farmslot/slot-config/sources';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  admitPlannedRunSources,
  refreshPlannedRunSources,
  type RunSourceAdmissionDependencies,
  SourcePlanRestart,
} from './run-admission.js';
import {
  sourceTestLock,
  sourceTestMaterialization,
  sourceTestPlan,
} from './source.test-support.js';

function fixture(planned = sourceTestLock('node-1')) {
  let run: Run = makeRun({ id: 'run-1', project: 'demo', status: 'slot-finding', slotId: null });
  run.sourcePlan = sourceTestPlan(planned);
  const desired = sourceTestLock('node-1');
  const events: string[] = [];
  let changed = false;
  const deps: RunSourceAdmissionDependencies = {
    getRun: () => run,
    authority: {
      lock: async () => desired,
      withCurrentLock: async (_lock, commit) => {
        if (changed) throw new Error('source pin changed');
        events.push('seal');
        return commit();
      },
    },
    gatewayMaterialization: async () => sourceTestMaterialization(desired, 'gateway'),
    nodeMaterialization: async () => {
      events.push('attest');
      return sourceTestMaterialization(desired, 'node-1');
    },
    replan: async (current, target) => {
      events.push('replan');
      assert.equal(currentProjectSources()?.materialization.lock.digest, desired.digest);
      return {
        ...current,
        sourcePlan: {
          ...current.sourcePlan!,
          lock: desired,
          workerLock: desired,
          validatedSlotId: target.slotId,
        },
      };
    },
    save: async (next) => {
      events.push('save');
      run = next;
    },
  };
  return {
    deps,
    desired,
    events,
    getRun: () => run,
    change: () => {
      changed = true;
    },
    cancel: () => {
      run = { ...run, status: 'cancelled' };
    },
  };
}

test('a node-specific replan restarts selection before attestation or an execution receipt', async () => {
  const f = fixture(sourceTestLock());
  await assert.rejects(
    admitPlannedRunSources('run-1', { nodeId: 'node-1' }, f.deps),
    SourcePlanRestart,
  );
  assert.deepEqual(f.events, ['replan', 'seal', 'save']);
  assert.equal(f.getRun().sourceProvenance, undefined);
  assert.equal(f.getRun().sourcePlan?.lock.digest, f.desired.digest);
  await admitPlannedRunSources('run-1', { nodeId: 'node-1' }, f.deps);
  assert.equal(f.getRun().sourcePlan, undefined);
  assert.deepEqual(f.getRun().sourceProvenance?.receiptIds, ['gateway-receipt', 'node-1-receipt']);
});

test('a different slot on the same node replans before execution attestation', async () => {
  const f = fixture();
  await assert.rejects(
    admitPlannedRunSources('run-1', { nodeId: 'node-1', slotId: 'other-platform-slot' }, f.deps),
    SourcePlanRestart,
  );
  assert.deepEqual(f.events, ['replan', 'seal', 'save']);
  assert.equal(f.getRun().sourcePlan?.validatedSlotId, 'other-platform-slot');
  assert.equal(f.getRun().sourceProvenance, undefined);
  await admitPlannedRunSources(
    'run-1',
    { nodeId: 'node-1', slotId: 'other-platform-slot' },
    f.deps,
  );
  assert.equal(f.getRun().sourceProvenance?.lock.digest, f.desired.digest);
});

test('explicit planning refresh never attests a node or creates run provenance', async () => {
  const f = fixture();
  await assert.rejects(
    refreshPlannedRunSources('run-1', { nodeId: 'node-1', slotId: 'requested' }, f.deps),
    SourcePlanRestart,
  );
  await refreshPlannedRunSources('run-1', { nodeId: 'node-1', slotId: 'requested' }, f.deps);
  assert.equal(f.events.includes('attest'), false);
  assert.equal(f.getRun().sourceProvenance, undefined);
});

test('a pin change during node preparation prevents the source seal and any saved admission', async () => {
  const f = fixture();
  f.deps.nodeMaterialization = async () => {
    f.change();
    return sourceTestMaterialization(f.desired, 'node-1');
  };
  await assert.rejects(
    admitPlannedRunSources('run-1', { nodeId: 'node-1' }, f.deps),
    /pin changed/,
  );
  assert.deepEqual(f.events, []);
  assert.equal(f.getRun().sourceProvenance, undefined);
});

test('cancellation or the wrong node receipt cannot publish source provenance', async () => {
  for (const mode of ['cancel', 'wrong-node']) {
    const f = fixture();
    f.deps.nodeMaterialization = async () => {
      if (mode === 'cancel') f.cancel();
      return sourceTestMaterialization(f.desired, mode === 'wrong-node' ? 'other-node' : 'node-1');
    };
    await assert.rejects(admitPlannedRunSources('run-1', { nodeId: 'node-1' }, f.deps));
    assert.equal(f.events.includes('save'), false);
    assert.equal(f.getRun().sourceProvenance, undefined);
  }
});

for (const stage of ['gateway', 'node'] as const) {
  for (const mutation of ['replay', 'plan', 'ownership'] as const) {
    test(`in-place ${mutation} during ${stage} attestation refuses obsolete admission`, async () => {
      const f = fixture();
      const original = f.getRun();
      const mutate = () => {
        if (mutation === 'replay')
          original.engineState = { ...original.engineState, generation: 1 };
        else if (mutation === 'plan') original.sourcePlan!.validatedSlotId = 'replayed-slot';
        else original.createdByPrincipalId = 'different-owner';
      };
      if (stage === 'gateway') {
        f.deps.gatewayMaterialization = async () => {
          mutate();
          return sourceTestMaterialization(f.desired, 'gateway');
        };
      } else {
        f.deps.nodeMaterialization = async () => {
          mutate();
          return sourceTestMaterialization(f.desired, 'node-1');
        };
      }
      await assert.rejects(
        admitPlannedRunSources('run-1', { nodeId: 'node-1' }, f.deps),
        /Run ownership or source plan changed/,
      );
      assert.equal(f.getRun(), original);
      assert.equal(f.events.includes('save'), false);
      assert.equal(original.sourceProvenance, undefined);
    });
  }
}

function retainedFixture() {
  const f = fixture();
  const prior = sourceTestLock('node-1');
  prior.context.runId = 'parent-run';
  prior.pinRevision = 3;
  prior.entries[0].scope = 'run';
  prior.entries[0].effectiveRef = 'experiment';
  const { digest: _digest, ...content } = prior;
  prior.digest = sourceLockDigest(content);
  let parent: Run | undefined = makeRun({ id: 'parent-run', project: 'demo' });
  parent.sourceProvenance = {
    ...sourceTestPlan(prior),
    state: 'locked',
    attemptId: 'parent-run:1',
    receiptIds: ['parent-receipt'],
    attempts: [{ id: 'parent-run:1', receiptIds: ['parent-receipt'] }],
  };
  f.deps.getRun = (id) => (id === 'parent-run' ? parent : f.getRun());
  f.deps.nodeMaterialization = async (nodeId, lock) => {
    f.events.push(`attest:${lock.digest}`);
    const result = sourceTestMaterialization(lock, nodeId);
    result.receipt.id = `${nodeId}:${lock.digest}`;
    return result;
  };
  return { ...f, prior, forgetParent: () => (parent = undefined) };
}

test('same-byte warm admission keeps the prior worker receipt and the new run scoped lock', async () => {
  const f = retainedFixture();
  await admitPlannedRunSources('run-1', { nodeId: 'node-1', retainedRunId: 'parent-run' }, f.deps);
  const provenance = f.getRun().sourceProvenance!;
  assert.deepEqual(provenance.lock, f.desired);
  assert.deepEqual(provenance.workerLock, f.prior);
  assert.notEqual(provenance.lock.digest, provenance.workerLock.digest);
  assert.deepEqual(provenance.receiptIds, [
    'gateway-receipt',
    `node-1:${f.desired.digest}`,
    `node-1:${f.prior.digest}`,
  ]);
});

test('changed or missing retained inputs refuse before node attestation', async () => {
  for (const change of ['commit', 'missing']) {
    const f = retainedFixture();
    if (change === 'missing') f.forgetParent();
    else {
      f.prior.entries[0].commit = 'c'.repeat(40);
      const { digest: _digest, ...content } = f.prior;
      f.prior.digest = sourceLockDigest(content);
    }
    await assert.rejects(
      admitPlannedRunSources('run-1', { nodeId: 'node-1', retainedRunId: 'parent-run' }, f.deps),
      /Retained worker source inputs/,
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.getRun().sourceProvenance, undefined);
  }
});

test('losing the retained owner while attesting prevents publishing admission', async () => {
  const f = retainedFixture();
  const attest = f.deps.nodeMaterialization;
  f.deps.nodeMaterialization = async (nodeId, lock) => {
    const result = await attest(nodeId, lock);
    if (lock.digest === f.prior.digest) f.forgetParent();
    return result;
  };
  await assert.rejects(
    admitPlannedRunSources('run-1', { nodeId: 'node-1', retainedRunId: 'parent-run' }, f.deps),
    /Retained worker ownership changed/,
  );
  assert.equal(f.events.includes('save'), false);
  assert.equal(f.getRun().sourceProvenance, undefined);
});
