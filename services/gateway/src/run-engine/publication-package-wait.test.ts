import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

import type { ReviewStatus } from '@farmslot/protocol';
import { openRunBundleStore, withRunBundleStoreLock } from '@farmslot/run-bundle';

import { createRun, getRun, updateRun } from '../runs/store.js';

import { reconcilePublishGateReviewPlanResult } from './post-dispatch-steps.js';
import { executeReadyGate } from './ready-gate.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

for (const stage of ['after-review', 'ready-gate'] as const) {
  test(`${stage}: a recorded warm verdict reaches the operator despite a busy bundle store`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gate-package-wait-'));
    const store = await openRunBundleStore({
      runsDir: path.join(root, 'runs'),
      home: path.join(root, 'home'),
      create: true,
    });
    const run = createRun({ flowType: 'fix-bug', project: 'demo', ticketOrPr: 'GATE-EXAMPLE' });
    const review: ReviewStatus = {
      id: 'example-lineage',
      source: 'dispatch',
      mode: 'warm',
      runner: 'codex',
      model: null,
      reviewerSessionId: 'example-session',
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      retryCount: 2,
      attempts: [
        { mode: 'cold', loopNumber: 1, verdict: 'issues', unresolvedCount: 1 },
        { mode: 'warm', loopNumber: 2, verdict: 'pass', unresolvedCount: 0 },
        { mode: 'warm', loopNumber: 3, verdict: 'pass', unresolvedCount: 0 },
      ],
    };
    updateRun(run.id, {
      status: 'human-gating',
      steps: [
        { name: 'human-gate', status: 'running', detail: 'Running dispatch codex review (1/1)...' },
      ],
      engineState: { publishGate: { reviews: [review] } },
    });
    const entered = deferred();
    const release = deferred();
    const holder = withRunBundleStoreLock(
      store,
      async () => {
        entered.resolve();
        await release.promise;
      },
      { label: 'another healthy capture' },
    );
    await entered.promise;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const preparing = deferred();
    let wrote = false;
    let advanced = false;
    const prepare = async (): Promise<never> => {
      preparing.resolve();
      assert.equal(
        getRun(run.id)!.steps[0].detail,
        'Preparing operator decision: checking publication package',
      );
      return withRunBundleStoreLock(store, async () => {
        wrote = true;
        throw new Error('fixture package unavailable');
      });
    };
    const execution =
      stage === 'after-review'
        ? reconcilePublishGateReviewPlanResult(
            run.id,
            [],
            { reviewIds: [review.id] },
            {
              getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
              prepareCompletionPackageForRun: prepare,
            },
          ).then(() => {
            advanced = true;
          })
        : executeReadyGate(run.id, {
            rebindSlot: async () => false,
            ensurePackage: prepare,
            createDecision: async (_id, _type, description, actions, payload) => {
              assert.match(description, /bundle.*wait/i);
              assert.deepEqual(
                actions.map(({ id }) => id),
                ['hold'],
              );
              assert.ok(payload?.kind === 'ready' && payload.stale && !payload.prPackage);
              advanced = true;
              return 'abort';
            },
          });
    // Attach rejection handling immediately; cleanup still waits for the execution.
    const outcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    let executionFailure: unknown;
    try {
      await preparing.promise;
      t.mock.timers.tick(60_001);
      for (let turn = 0; turn < 30; turn++) await flushed();
      assert.equal(
        advanced,
        true,
        'storage wait must yield to the existing operator decision path',
      );
      assert.equal(wrote, false, 'an expired queued capture never runs later');
      assert.deepEqual(getRun(run.id)!.engineState!.publishGate!.reviews, [review]);
      assert.equal(getRun(run.id)!.status, 'human-gating');
    } finally {
      release.resolve();
      await holder;
      executionFailure = await outcome;
      t.mock.timers.reset();
      await deleteTestRunIfPresent(run.id);
      await rm(root, { recursive: true, force: true });
    }
    if (executionFailure) throw executionFailure;
    assert.equal(wrote, false);
  });
}
