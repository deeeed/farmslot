import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, SlotReleaseParams } from '@farmslot/protocol';

import { cleanupEvalHarnessForTerminalRun, terminalSlotCleanup } from './orchestrator.js';

const RELEASE: SlotReleaseParams = {
  slotId: 'macwork-ff-3',
  keepWork: true,
  keepWarm: true,
  detachRuns: false,
  expectedRunId: 'run-1',
};

const RUN = { id: 'run-1', slotId: 'macwork-ff-3' } as Run;

test('a terminal failure route performs the release its step recorded, then the cleanup', async () => {
  // The CI-blocked case: the ci-watch step defers a keep-work/keep-warm release
  // and then leaves the run terminal, so the engine routes it through a failure
  // branch. Taking the release only in the completion tail dropped it — the
  // handoff was lost and the failure cleanup hard-reset the slot instead.
  const order: string[] = [];
  const cleanup = terminalSlotCleanup(
    RELEASE,
    async () => void order.push('failure-cleanup'),
    async (params) => void order.push(`release:${params.slotId}:keepWarm=${params.keepWarm}`),
  );
  await cleanup(RUN);
  assert.deepEqual(order, ['release:macwork-ff-3:keepWarm=true', 'failure-cleanup']);
});

test('the ownership-checked cleanup still runs when the deferred release fails', async () => {
  // Before the release moved out of the step body it was wrapped in its own
  // try/catch and the failure cleanup ran regardless. Letting a failed release
  // skip it is how a slot gets stranded in `releasing`.
  const order: string[] = [];
  const cleanup = terminalSlotCleanup(
    RELEASE,
    async () => void order.push('failure-cleanup'),
    async () => {
      order.push('release');
      throw new Error('tmux kill refused');
    },
  );
  await assert.rejects(cleanup(RUN), /deferred release: tmux kill refused/);
  assert.deepEqual(order, ['release', 'failure-cleanup']);
});

test('a run that deferred nothing keeps exactly its failure cleanup', async () => {
  const failureCleanup = async () => {};
  assert.equal(terminalSlotCleanup(undefined, failureCleanup), failureCleanup);
});

const EVAL_RUN = {
  id: 'run-eval',
  slotId: 'macwork-ff-3',
  engineState: { evalExperiment: { packagePath: '/tmp/pkg' } },
} as unknown as Run;

test('a failed eval harness cleanup is reported, not recorded as a clean one', async () => {
  // `throwOnFailure: false` keeps the hook from throwing, so the RETURNED status
  // is the only place the failure appears. Ignoring it let a failed harness
  // cleanup ride out as a successful advisory effect on the terminal
  // transition, with the candidate package left behind and nothing saying so.
  await assert.rejects(
    cleanupEvalHarnessForTerminalRun(EVAL_RUN, async () => ({
      skipped: false,
      status: 'failed' as const,
      logPath: 'artifacts/recipe-harness/cleanup.log',
    })),
    /eval harness cleanup failed for run-eval.*cleanup\.log/s,
  );
});

test('a passing or skipped eval harness cleanup resolves quietly', async () => {
  await cleanupEvalHarnessForTerminalRun(EVAL_RUN, async () => ({
    skipped: false,
    status: 'passed' as const,
  }));
  await cleanupEvalHarnessForTerminalRun(EVAL_RUN, async () => ({ skipped: true }));
});

test('a run with no eval experiment never touches the harness', async () => {
  let called = false;
  await cleanupEvalHarnessForTerminalRun(
    { id: 'run-plain', slotId: 'macwork-ff-3' } as Run,
    async () => {
      called = true;
      return { skipped: true };
    },
  );
  assert.equal(called, false);
});
