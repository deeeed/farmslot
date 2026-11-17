import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import type { FinalizeStepContext } from './finalize-step.js';

await import('../runtime/mock-pty.test-support.js');

// Close as Shipped used to record whatever PR number the run already carried,
// skipping the merged-PR proof whenever that field was set. An earlier gate
// persists the probe's answer and never replaces it, so the field can name a
// PR that merged an OLDER head: the run then completes as published against a
// PR that does not contain the head being closed.
const packageHead = 'a'.repeat(40);
const stalePrNumber = 388;
const shippedPrNumber = 400;

const probeCalls: { prNumber: number | undefined; headSha: string | undefined }[] = [];
let probeResult: number | null = shippedPrNumber;
const persisted: number[] = [];

const linkage = await import('../integrations/pr-linkage.js');
mock.module('../integrations/pr-linkage.js', {
  namedExports: {
    ...linkage,
    findMergedPRNumber: async (run: { prNumber?: number }, _repo: string, headSha?: string) => {
      probeCalls.push({ prNumber: run.prNumber, headSha });
      return probeResult;
    },
    // Delegates, so the assertions see the real persisted state.
    persistRunPrNumber: async (runId: string, prNumber: number) => {
      persisted.push(prNumber);
      await linkage.persistRunPrNumber(runId, prNumber);
    },
  },
});

const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { latestResolvedHumanGateDecision } = await import('./decision-replay.js');
const { executeFinalizeStep } = await import('./finalize-step.js');
const { deleteTestRunIfPresent, makeReadyGatePackage } = await import('./test-fixtures.js');

const closeAsShipped: RunDecision = {
  id: 'publication',
  type: 'engine_human_gate',
  title: 'Publication gate',
  description: '',
  actions: [],
  createdAt: '2026-11-18T00:00:00Z',
  resolvedAt: '2026-11-18T00:01:00Z',
  resolvedAction: 'close-as-shipped',
};

const finalize = async (t: { after: (fn: () => void) => void }) => {
  probeCalls.length = 0;
  persisted.length = 0;
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'generic-project',
    ticketOrPr: 'TAT-4644',
    branch: 'fix/reused',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'completing',
    slotId: 'close-as-shipped-fixture',
    prNumber: stalePrNumber,
    decisions: [closeAsShipped],
  });
  const context = {
    broadcastFn: () => {},
    latestResolvedHumanGateDecision,
    loadProjectVarsOrNull: async () => ({
      projectJson: { default_branch: 'main', ci: { repo: 'owner/repo' } },
    }),
    readPreparedPackage: async () => makeReadyGatePackage({ headSha: packageHead }),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
  } as unknown as FinalizeStepContext;
  await executeFinalizeStep(run.id, context);
  return run;
};

test('close-as-shipped re-proves a saved PR number against the head it is closing', async (t) => {
  probeResult = shippedPrNumber;
  const run = await finalize(t);
  assert.deepEqual(
    probeCalls,
    [{ prNumber: stalePrNumber, headSha: packageHead }],
    'the probe must run even when the run already carries a PR number',
  );
  assert.equal(getRun(run.id)?.prNumber, shippedPrNumber);
  assert.deepEqual(persisted, [shippedPrNumber]);
  assert.equal(
    getRun(run.id)?.engineState?.publishGate?.publicationStatus,
    'published_ready',
    'the proved PR is the one the run is published against',
  );
});

test('close-as-shipped claims no publication when nothing proves it shipped', async (t) => {
  probeResult = null;
  const run = await finalize(t);
  assert.equal(probeCalls.length, 1);
  assert.deepEqual(persisted, []);
  assert.notEqual(
    getRun(run.id)?.engineState?.publishGate?.publicationStatus,
    'published_ready',
    'a stale saved number must not become a publication claim',
  );
});
