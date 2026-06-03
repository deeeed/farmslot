import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FamilyImprovementProposalTracker } from './family-observability-improvement-proposals.js';

function createHarness(timeoutMs = 10) {
  let proposingFor = new Set<string>();
  const proposalError = new Map<string, string>();
  let ticks = 0;
  const warnings: string[] = [];
  const tracker = new FamilyImprovementProposalTracker(
    {
      getProposingFor: () => proposingFor,
      setProposingFor: (next) => {
        proposingFor = next;
      },
      setProposalError: (runId, message) => {
        if (message) proposalError.set(runId, message);
        else proposalError.delete(runId);
      },
      incrementElapsedTick: () => {
        ticks += 1;
      },
      warnTimedOut: (runId) => warnings.push(runId),
    },
    timeoutMs,
  );
  return { proposalError, proposingFor: () => proposingFor, ticks: () => ticks, tracker, warnings };
}

test('FamilyImprovementProposalTracker tracks and clears proposing runs', () => {
  const harness = createHarness();
  harness.proposalError.set('run-1', 'old error');

  harness.tracker.start('run-1');
  assert.equal(harness.proposingFor().has('run-1'), true);
  assert.equal(harness.proposalError.has('run-1'), false);

  harness.tracker.markDone('run-1');
  assert.equal(harness.proposingFor().has('run-1'), false);
  assert.equal(harness.tracker.elapsedSeconds('run-1'), 0);
  harness.tracker.dispose();
});

test('FamilyImprovementProposalTracker marks long-running proposals as errored', async () => {
  const harness = createHarness(1);
  harness.tracker.start('run-1');
  await delay(5);

  assert.equal(harness.proposingFor().has('run-1'), false);
  assert.match(harness.proposalError.get('run-1') ?? '', /longer than expected/);
  assert.deepEqual(harness.warnings, ['run-1']);
  harness.tracker.dispose();
});
