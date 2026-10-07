import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

// The run store must be isolated before anything imports it.
const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-stacked-tick-test-'));
process.env.FARMSLOT_RUNS_DIR = path.join(testDir, 'runs');
test.after(() => rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const runs = await import('../runs/store.js');
const { cancelPlan } = await import('./cancel-transition.js');
const { routeRunTransition } = await import('./transition-router.js');
await runs.loadAllRuns();

/** Cancels `seed` through the real router and returns the graph ids it ticked. */
async function cancelAndCollectTicks(seed: Run): Promise<string[]> {
  const ticked: string[] = [];
  let stored = seed;
  const noop = async () => undefined;
  const collaborators = {
    cancelEngine: () => undefined,
    invalidateWarmSessions: () => undefined,
    settleBacklog: noop,
    tickWorkGraph: async (graphId: string) => void ticked.push(graphId),
    releaseCapabilities: noop,
    releaseSlot: noop,
    emit: () => undefined,
  };
  await routeRunTransition(
    { kind: 'cancel', runId: seed.id, actor: 'operator', reason: 'test' },
    {
      getRun: () => stored,
      updateRun: (_id, partial) => {
        stored = { ...stored, ...partial } as Run;
        return stored;
      },
      planFor: (request) => cancelPlan(request, collaborators),
      onMutated: () => undefined,
    },
  );
  return ticked;
}

test('a follow-up of a stacked run ticks that run’s graph when it ends', async () => {
  const stacked = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'T-1',
    workGraphId: 'wg_stacked',
    workNodeId: 'wn_b',
  });
  runs.updateRun(stacked.id, {
    stack: {
      upstreamNodeId: 'wn_a',
      upstreamRunId: 'run-a',
      baseBranch: 'feat/a',
      upstreamPrNumber: 41,
    },
  });
  const followUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#42',
    familyId: stacked.familyId,
    parentRunId: stacked.id,
  });
  assert.deepEqual(await cancelAndCollectTicks(runs.getRun(followUp.id)!), ['wg_stacked']);
});

test('a follow-up outside a stack ticks nothing, as before', async () => {
  const parent = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'T-2',
    workGraphId: 'wg_plain',
    workNodeId: 'wn_x',
  });
  const followUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#43',
    familyId: parent.familyId,
    parentRunId: parent.id,
  });
  assert.deepEqual(await cancelAndCollectTicks(runs.getRun(followUp.id)!), []);
  assert.deepEqual(await cancelAndCollectTicks(runs.getRun(parent.id)!), ['wg_plain']);
});
