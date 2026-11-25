import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

process.env.FARMSLOT_RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'farmslot-blocked-ci-fix-'));

const failedCheck = { name: 'Check changelog', status: 'fail' };
const passedCheck = { name: 'Check changelog', status: 'pass' };
const pendingCheck = { name: 'Check changelog', status: 'pending' };
const comment = {
  author: 'review-bot',
  label: 'review',
  action: 'fix',
  bodyPreview: 'Review the change',
  createdAt: '2026-09-23T00:00:00Z',
  source: 'issue',
  workerResponded: false,
};
const snapshots: Array<{
  checks: (typeof failedCheck)[];
  allPassed: boolean;
  comments?: (typeof comment)[];
  mergeConflict?: boolean;
}> = [];
const forcedReads: boolean[] = [];

mock.module('../methods/pr.js', {
  namedExports: {
    prStatus: async ({ force }: { force?: boolean }) => {
      forcedReads.push(force === true);
      const snapshot = snapshots.shift() ?? { checks: [failedCheck], allPassed: false };
      const failed = snapshot.checks.filter((check) => check.status === 'fail').length;
      const pending = snapshot.checks.filter((check) => check.status === 'pending').length;
      const comments = 'comments' in snapshot ? (snapshot.comments ?? []) : [];
      return {
        pr: {
          prNumber: 10384,
          prState: 'OPEN',
          merged: false,
          mergeConflict: snapshot.mergeConflict ?? false,
          checks: snapshot.checks,
          checkSnapshot: {
            pr: 10384,
            repo: 'MetaMask/core',
            fetchedAt: new Date().toISOString(),
            checks: snapshot.checks.map((check) => ({
              name: check.name,
              status: check.status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
              conclusion:
                check.status === 'pending' ? null : snapshot.allPassed ? 'SUCCESS' : 'FAILURE',
              timestamp: null,
              detailsUrl: null,
            })),
          },
          checkSummary: {
            passed: snapshot.allPassed ? 1 : 0,
            failed,
            pending,
            skipped: 0,
            total: 1,
          },
          allPassed: snapshot.allPassed,
          anyFailed: failed > 0,
          failedNames: failed > 0 ? ['Check changelog'] : [],
          actionableBotComments: comments,
          recommendation: snapshot.allPassed && comments.length === 0 ? 'READY' : 'NEEDS_ATTENTION',
        },
      };
    },
    computePRRecommendation: () => 'MERGE',
  },
});

mock.module('./inline-fix.js', {
  namedExports: {
    getSlotHeadSha: async () => 'unchanged-head',
    isInlineFixDedupedNow: async () => false,
    rerunFailedChecks: async () => {},
    tryInlineCIFix: async () => ({
      attempted: true,
      success: false,
      blocked: true,
      blockedReason: 'Worker reported success without advancing HEAD',
      attempts: 1,
    }),
  },
});

const { monitorCI, pokeCIPoll, resolveCIDecision } = await import('./service.js');
const { createRun, getRun, loadAllRuns, updateRun } = await import('../runs/store.js');

test('ci-watch rechecks GitHub and completes when the unchanged HEAD turns green', async () => {
  await loadAllRuns();
  snapshots.push(
    { checks: [failedCheck], allPassed: false },
    { checks: [passedCheck], allPassed: true },
    { checks: [passedCheck], allPassed: true },
  );
  forcedReads.length = 0;
  const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'CI-TEST' });

  const outcome = await monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  assert.equal(outcome.result, 'passed');
  assert.deepEqual(forcedReads, [false, true, true]);
  assert.equal(getRun(run.id)?.decisions.length, 0);
});

async function expectBlockedFixDecision(initial: (typeof snapshots)[number]): Promise<void> {
  snapshots.push(initial, initial);
  forcedReads.length = 0;
  const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'CI-TEST' });
  const monitoring = monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  let decision = getRun(run.id)?.decisions.find((item) => item.type === 'ci_inline_fix_blocked');
  for (let attempts = 0; !decision && attempts < 100; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    decision = getRun(run.id)?.decisions.find((item) => item.type === 'ci_inline_fix_blocked');
  }
  assert.ok(decision);
  assert.equal(getRun(run.id)?.status, 'blocked');
  assert.deepEqual(forcedReads, [false, true]);

  resolveCIDecision(decision.id, 'abort');
  assert.equal((await monitoring).result, 'aborted');
  assert.equal(
    getRun(run.id)?.decisions.find((item) => item.id === decision.id)?.resolvedAction,
    'abort',
  );
}

test('ci-watch exposes an operator decision when the fresh checks still fail', async () => {
  await expectBlockedFixDecision({ checks: [failedCheck], allPassed: false });
});

test('validation runs abort instead of waiting for an operator decision', async () => {
  snapshots.push(
    { checks: [failedCheck], allPassed: false },
    { checks: [failedCheck], allPassed: false },
  );
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'CI-TEST',
    mode: 'validation',
  });

  const outcome = await monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  assert.equal(outcome.result, 'aborted');
  assert.equal(
    getRun(run.id)?.decisions.find((item) => item.type === 'ci_inline_fix_blocked')?.resolvedAction,
    'abort',
  );
});

test('ci-watch exposes an operator decision when actionable comments remain', async () => {
  await expectBlockedFixDecision({ checks: [passedCheck], allPassed: true, comments: [comment] });
});

test('ci-watch rechecks pending CI and finishes when checks turn green', async () => {
  snapshots.push(
    { checks: [pendingCheck], allPassed: false, comments: [comment] },
    { checks: [passedCheck], allPassed: true },
    { checks: [passedCheck], allPassed: true },
  );
  forcedReads.length = 0;
  const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'CI-TEST' });

  const outcome = await monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  assert.equal(outcome.result, 'passed');
  assert.deepEqual(forcedReads, [false, true, true]);
  assert.equal(getRun(run.id)?.decisions.length, 0);
});

// ─── Operator hold (fcfb5124) ───
// Each case drives the real monitorCI loop. A conflicted PR auto-dispatches an
// update-branch child by default, which is what spawned ee363d15; a hold must stop
// that and put the conflict to the operator instead.

const HOLD_GATE = {
  type: 'ci_inline_fix_blocked' as const,
  actions: [
    { id: 'dispatch-pr-complete', label: 'Dispatch pr-complete', style: 'primary' as const },
    { id: 'wait', label: 'Keep watching CI', style: 'secondary' as const },
    { id: 'abort', label: 'Abort', style: 'danger' as const },
  ],
};
const conflicted = { checks: [failedCheck], allPassed: false, mergeConflict: true };

function holdDecision(resolvedAt: string) {
  return {
    id: `hold-${resolvedAt}`,
    ...HOLD_GATE,
    title: 'inline fix blocked',
    description: 'inline fix blocked',
    createdAt: resolvedAt,
    resolvedAt,
    resolvedAction: 'wait',
  };
}

function watch(seed: (runId: string) => void = () => {}) {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'CI-TEST',
  });
  seed(run.id);
  let settled = false;
  // Aborted in each test's finally, so a failed assertion cannot leave the watch
  // sleeping out its 600 s poll interval and run the file into its time budget.
  const controller = new AbortController();
  const monitoring = monitorCI(run.id, 10384, 'MetaMask/core', controller.signal).then(
    (outcome) => {
      settled = true;
      return outcome;
    },
  );
  const decisions = (type: string) =>
    getRun(run.id)?.decisions.filter((item) => item.type === type) ?? [];
  const open = async (type: string) => {
    for (let attempts = 0; attempts < 200; attempts++) {
      const found = decisions(type).find((item) => !item.resolvedAt);
      if (found || settled) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  };
  // A wait sleeps a full poll interval; wake it the way a push would, once armed.
  const poke = async () => {
    for (let attempts = 0; attempts < 200 && !pokeCIPoll(run.id).woken; attempts++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { run, controller, monitoring, decisions, open, poke, settled: () => settled };
}

test('control: with no hold, a conflicted PR auto-dispatches', async () => {
  // This is the behaviour the hold must stop, and it proves the project config
  // really enables merge_conflict auto-dispatch: without it, the hold cases below
  // would pass vacuously.
  snapshots.length = 0;
  snapshots.push(conflicted, conflicted);
  const w = watch();
  try {
    await w.open('ci_merge_conflict');
    assert.equal(w.settled(), true, 'the watch ended by dispatching');
    assert.equal(w.decisions('ci_merge_conflict').length, 0, 'nobody was asked');
  } finally {
    w.controller.abort();
    snapshots.length = 0;
  }
});

test('choosing wait at an inline-fix gate holds the PR through a later merge conflict', async () => {
  // Run fcfb5124: wait at inline_fix_blocked, then the expected conflict.
  snapshots.length = 0;
  snapshots.push(
    { checks: [failedCheck], allPassed: false },
    { checks: [failedCheck], allPassed: false },
    conflicted,
  );
  const w = watch();
  try {
    const blocked = await w.open('ci_inline_fix_blocked');
    assert.ok(blocked, 'the inline-fix gate is raised first');
    assert.ok(
      blocked.actions.some((action) => action.id === 'dispatch-pr-complete'),
      'the gate offered a dispatch, so wait here is a hold',
    );
    resolveCIDecision(blocked.id, 'wait');
    await w.poke();

    const conflict = await w.open('ci_merge_conflict');
    assert.equal(w.settled(), false, 'the watch must not finish by auto-dispatching');
    assert.ok(conflict, 'the conflict is put to the operator');
    assert.ok(
      conflict.actions.some((action) => action.id === 'wait' && action.label === 'Keep holding'),
      'and they can keep holding',
    );
    resolveCIDecision(conflict.id, 'skip');
    assert.equal((await w.monitoring).result, 'passed');
  } finally {
    w.controller.abort();
    snapshots.length = 0;
  }
});

test('a hold chosen before a gateway restart still holds', async () => {
  // Restart recovery re-presents the card with no monitor running, and the
  // operator's wait is persisted on run.decisions with no live resolver. The next
  // monitorCI must read the hold from there; a flag set only by a live gate would
  // be missing and the conflict would auto-dispatch.
  snapshots.length = 0;
  snapshots.push(conflicted, conflicted);
  const w = watch((runId) =>
    updateRun(runId, { decisions: [holdDecision('2026-11-24T13:28:57.000Z')] }),
  );
  try {
    const conflict = await w.open('ci_merge_conflict');
    assert.equal(w.settled(), false, 'no auto-dispatch after the restart');
    assert.ok(conflict, 'the conflict is put to the operator');
  } finally {
    w.controller.abort();
    snapshots.length = 0;
  }
});

test('keep holding does not re-ask while the head and the conflict are unchanged', async () => {
  snapshots.length = 0;
  snapshots.push(conflicted, conflicted, conflicted);
  const w = watch((runId) =>
    updateRun(runId, { decisions: [holdDecision('2026-11-24T13:28:57.000Z')] }),
  );
  try {
    const first = await w.open('ci_merge_conflict');
    assert.ok(first);
    resolveCIDecision(first.id, 'wait');
    await w.poke();
    // Give the loop the poll it was woken for; an unchanged state must stay quiet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(w.settled(), false);
    assert.equal(
      w.decisions('ci_merge_conflict').filter((item) => !item.resolvedAt).length,
      0,
      'no new card for the same head and conflict',
    );
  } finally {
    w.controller.abort();
    snapshots.length = 0;
  }
});

test('a dispatch answered before the hold is not reused after it', async () => {
  // A dispatch-update-branch answered earlier at this gate, then the hold. Reusing
  // the earlier answer would dispatch straight past the operator's hold.
  snapshots.length = 0;
  snapshots.push(conflicted, conflicted);
  const w = watch((runId) =>
    updateRun(runId, {
      decisions: [
        {
          id: 'earlier-dispatch',
          type: 'ci_merge_conflict',
          title: 'merge conflict',
          description: 'merge conflict',
          actions: [
            { id: 'dispatch-update-branch', label: 'Dispatch update-branch', style: 'primary' },
          ],
          createdAt: '2026-11-24T12:00:00.000Z',
          resolvedAt: '2026-11-24T12:00:00.000Z',
          resolvedAction: 'dispatch-update-branch',
        },
        holdDecision('2026-11-24T13:28:57.000Z'),
      ],
    }),
  );
  try {
    const conflict = await w.open('ci_merge_conflict');
    assert.equal(w.settled(), false, 'the earlier dispatch was not replayed');
    assert.ok(conflict, 'a fresh question is asked instead');
  } finally {
    w.controller.abort();
    snapshots.length = 0;
  }
});
