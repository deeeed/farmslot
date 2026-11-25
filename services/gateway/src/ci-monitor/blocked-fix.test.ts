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
  /** GitHub's `headRefOid`; defaults to one fixed head. */
  headSha?: string;
  /** Defaults to CONFLICTING or MERGEABLE from `mergeConflict`. */
  mergeable?: string;
  /** Raw failing check names, finer than the watched groups. */
  allFailedNames?: string[];
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
          mergeable: snapshot.mergeable ?? (snapshot.mergeConflict ? 'CONFLICTING' : 'MERGEABLE'),
          headSha: snapshot.headSha ?? 'pr-head-1',
          allFailedNames: snapshot.allFailedNames ?? (failed > 0 ? ['Check changelog'] : []),
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

const BLOCKED_FIX = {
  attempted: true,
  success: false,
  blocked: true,
  blockedReason: 'Worker reported success without advancing HEAD',
  attempts: 1,
};
// A held PR's real tryInlineCIFix returns null (fix-scope.test.ts covers that); the
// held cases below set it so the gates after the inline fix are reached.
const inlineFix: { result: typeof BLOCKED_FIX | null } = { result: BLOCKED_FIX };

mock.module('./inline-fix.js', {
  namedExports: {
    getSlotHeadSha: async () => 'unchanged-head',
    isInlineFixDedupedNow: async () => false,
    rerunFailedChecks: async () => {},
    tryInlineCIFix: async () => inlineFix.result,
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
const HELD_AT = '2026-11-24T13:28:57.000Z';

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

/** A "Keep holding" answered at a gate, for the state named by `holdKey`. */
function keptHolding(type: `ci_${string}`, resolvedAt: string, holdKey: string) {
  return {
    id: `kept-${type}-${resolvedAt}`,
    type,
    title: type,
    description: type,
    actions: [{ id: 'wait', label: 'Keep holding', style: 'secondary' as const }],
    createdAt: resolvedAt,
    resolvedAt,
    resolvedAction: 'wait',
    context: { holdKey },
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
  const openCards = () => getRun(run.id)?.decisions.filter((item) => !item.resolvedAt) ?? [];
  const open = async (type: string) => {
    for (let attempts = 0; attempts < 200; attempts++) {
      const found = decisions(type).find((item) => !item.resolvedAt);
      if (found || settled) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  };
  const nextPollAt = () =>
    (
      getRun(run.id)?.steps.find((step) => step.name === 'ci-watch')?.outputs as
        | { nextPollAt?: string | null }
        | undefined
    )?.nextPollAt ?? null;
  // Wait until the loop has handled a read: it either armed a new sleep (a fresh
  // nextPollAt) or stopped to ask (nextPollAt cleared), or the watch ended.
  const handled = async (reads: number, before: string | null) => {
    for (let attempts = 0; attempts < 200; attempts++) {
      if (settled || (forcedReads.length > reads && nextPollAt() !== before)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('the poll was not handled');
  };
  // A wait sleeps a full poll interval; wake it the way a push would, once armed,
  // and wait for that poll to be handled.
  const pollOnce = async () => {
    for (let attempts = 0; attempts < 200 && !nextPollAt(); attempts++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const reads = forcedReads.length;
    const before = nextPollAt();
    let woken = false;
    for (let attempts = 0; attempts < 200 && !woken; attempts++) {
      woken = pokeCIPoll(run.id).woken === true;
      if (!woken) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(woken, 'the watch was asleep and took the poke');
    await handled(reads, before);
  };
  return {
    run,
    controller,
    monitoring,
    decisions,
    openCards,
    open,
    pollOnce,
    firstPoll: () => handled(0, null),
    settled: () => settled,
  };
}

async function held(body: () => Promise<void>, fix: typeof inlineFix.result = BLOCKED_FIX) {
  snapshots.length = 0;
  forcedReads.length = 0;
  inlineFix.result = fix;
  try {
    await body();
  } finally {
    snapshots.length = 0;
    inlineFix.result = BLOCKED_FIX;
  }
}

test('control: with no hold, a conflicted PR auto-dispatches', async () => {
  // This is the behaviour the hold must stop, and it proves the project config
  // really enables merge_conflict auto-dispatch: without it, the hold cases below
  // would pass vacuously.
  await held(async () => {
    snapshots.push(conflicted, conflicted);
    const w = watch();
    try {
      await w.open('ci_merge_conflict');
      assert.equal(w.settled(), true, 'the watch ended by dispatching');
      assert.equal(w.decisions('ci_merge_conflict').length, 0, 'nobody was asked');
    } finally {
      w.controller.abort();
    }
  });
});

test('choosing wait at an inline-fix gate holds the PR through a later merge conflict', async () => {
  // Run fcfb5124: wait at inline_fix_blocked, then the expected conflict.
  await held(async () => {
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
      await w.pollOnce();

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
    }
  });
});

test('a hold chosen before a gateway restart still holds', async () => {
  // Restart recovery re-presents the card with no monitor running, and the
  // operator's wait is persisted on run.decisions with no live resolver. The next
  // monitorCI must read the hold from there; a flag set only by a live gate would
  // be missing and the conflict would auto-dispatch.
  await held(async () => {
    snapshots.push(conflicted, conflicted);
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const conflict = await w.open('ci_merge_conflict');
      assert.equal(w.settled(), false, 'no auto-dispatch after the restart');
      assert.ok(conflict, 'the conflict is put to the operator');
    } finally {
      w.controller.abort();
    }
  });
});

test('keep holding at a conflict stays quiet while the PR head and the conflict are unchanged', async () => {
  await held(async () => {
    snapshots.push(conflicted, conflicted, conflicted);
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const first = await w.open('ci_merge_conflict');
      assert.ok(first);
      resolveCIDecision(first.id, 'wait');
      await w.pollOnce();
      assert.equal(w.settled(), false);
      assert.deepEqual(w.openCards(), [], 'no new card for the same head and conflict');
    } finally {
      w.controller.abort();
    }
  });
});

test('a "Keep holding" given before a gateway restart stays quiet after it', async () => {
  // The answer is read from run.decisions, not a variable of the monitor that gave it.
  await held(async () => {
    snapshots.push(conflicted, conflicted);
    const w = watch((runId) =>
      updateRun(runId, {
        decisions: [
          holdDecision(HELD_AT),
          keptHolding('ci_merge_conflict', '2026-11-24T13:40:00.000Z', 'pr-head-1'),
        ],
      }),
    );
    try {
      await w.firstPoll();
      assert.equal(w.settled(), false);
      assert.deepEqual(w.openCards(), [], 'the restarted watch does not ask again');
    } finally {
      w.controller.abort();
    }
  });
});

test('a new PR head re-raises a held conflict, even when the slot HEAD has not moved', async () => {
  // The operator holds, then pushes a rebase from their own machine. The slot's
  // checkout is unchanged (the mocked slot HEAD never moves); the PR head is not.
  await held(async () => {
    snapshots.push(conflicted, { ...conflicted, headSha: 'pr-head-2' });
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const first = await w.open('ci_merge_conflict');
      assert.ok(first);
      resolveCIDecision(first.id, 'wait');
      await w.pollOnce();
      assert.ok(await w.open('ci_merge_conflict'), 'the conflict on the new head is asked about');
    } finally {
      w.controller.abort();
    }
  });
});

test('a held conflict that clears and returns at the same head asks again', async () => {
  await held(async () => {
    snapshots.push({ checks: [pendingCheck], allPassed: false }, conflicted);
    const w = watch((runId) =>
      updateRun(runId, {
        decisions: [
          holdDecision(HELD_AT),
          keptHolding('ci_merge_conflict', '2026-11-24T13:40:00.000Z', 'pr-head-1'),
        ],
      }),
    );
    try {
      await w.firstPoll();
      assert.deepEqual(w.openCards(), [], 'GitHub reports the PR mergeable: nothing to ask');
      await w.pollOnce();
      assert.ok(await w.open('ci_merge_conflict'), 'the returning conflict is asked about');
    } finally {
      w.controller.abort();
    }
  });
});

test('a held conflict stays quiet through an UNKNOWN mergeability read', async () => {
  // GitHub reports UNKNOWN while it recomputes after the base moves. Read as "no
  // conflict", the failed check beside the conflict (as in fcfb5124) is put to the
  // operator on every recompute.
  await held(async () => {
    snapshots.push(conflicted, {
      checks: [failedCheck],
      allPassed: false,
      mergeConflict: false,
      mergeable: 'UNKNOWN',
    });
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const first = await w.open('ci_merge_conflict');
      assert.ok(first);
      resolveCIDecision(first.id, 'wait');
      await w.pollOnce();
      assert.equal(w.settled(), false);
      assert.deepEqual(w.openCards(), [], 'no failed-check card at the UNKNOWN read');
    } finally {
      w.controller.abort();
    }
  }, null);
});

test('a held conflict still reaches the CI wait cap', async () => {
  // Keep holding on a Friday while the blocking PR takes days: the slot must not stay
  // occupied past the wait cap with no "Release slot" card.
  await held(async () => {
    snapshots.push(conflicted, conflicted);
    const w = watch((runId) =>
      updateRun(runId, {
        decisions: [
          holdDecision(HELD_AT),
          keptHolding('ci_merge_conflict', '2026-11-24T13:40:00.000Z', 'pr-head-1'),
        ],
        ciWatchState: {
          consecutiveAttempts: 0,
          totalAttempts: 0,
          skips: 0,
          timeoutWindowStartedAt: '2025-11-24T13:40:00.000Z',
        },
      }),
    );
    try {
      const timeout = await w.open('ci_ci_timeout');
      assert.ok(timeout, 'the wait cap asks');
      assert.ok(
        timeout.actions.some((action) => action.id === 'skip' && action.label === 'Release slot'),
      );
      assert.equal(w.decisions('ci_merge_conflict').filter((item) => !item.resolvedAt).length, 0);
    } finally {
      w.controller.abort();
    }
  });
});

test('a dispatch answered before the hold is not reused after it', async () => {
  // A dispatch-update-branch answered earlier at this gate, then the hold. Reusing
  // the earlier answer would dispatch straight past the operator's hold.
  await held(async () => {
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
          holdDecision(HELD_AT),
        ],
      }),
    );
    try {
      const conflict = await w.open('ci_merge_conflict');
      assert.equal(w.settled(), false, 'the earlier dispatch was not replayed');
      assert.ok(conflict, 'a fresh question is asked instead');
    } finally {
      w.controller.abort();
    }
  });
});

test('a dispatch answered before a later "Keep holding" is not reused after it', async () => {
  // Answered after the hold (it then found no snapshot to dispatch from), followed
  // by Keep holding on another head. The operator's latest word is to wait.
  await held(async () => {
    snapshots.push(conflicted, conflicted);
    const w = watch((runId) =>
      updateRun(runId, {
        decisions: [
          holdDecision(HELD_AT),
          {
            id: 'refused-dispatch',
            type: 'ci_merge_conflict',
            title: 'merge conflict',
            description: 'merge conflict',
            actions: [
              { id: 'dispatch-update-branch', label: 'Dispatch update-branch', style: 'primary' },
            ],
            createdAt: '2026-11-24T13:35:00.000Z',
            resolvedAt: '2026-11-24T13:35:00.000Z',
            resolvedAction: 'dispatch-update-branch',
          },
          keptHolding('ci_merge_conflict', '2026-11-24T13:40:00.000Z', 'pr-head-0'),
        ],
      }),
    );
    try {
      const conflict = await w.open('ci_merge_conflict');
      assert.equal(w.settled(), false, 'the earlier dispatch was not replayed');
      assert.ok(conflict, 'a fresh question is asked instead');
    } finally {
      w.controller.abort();
    }
  });
});

test('keep holding at a failed-check gate stays quiet for the same failure', async () => {
  await held(async () => {
    snapshots.push(
      { checks: [failedCheck], allPassed: false },
      { checks: [failedCheck], allPassed: false },
    );
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const failed = await w.open('ci_ci_failed');
      assert.ok(failed);
      assert.ok(
        failed.actions.some((action) => action.id === 'wait' && action.label === 'Keep holding'),
      );
      resolveCIDecision(failed.id, 'wait');
      await w.pollOnce();
      assert.equal(w.settled(), false, 'Keep holding keeps watching; it does not finish the watch');
      assert.deepEqual(w.openCards(), [], 'no new card for the same failure');
    } finally {
      w.controller.abort();
    }
  }, null);
});

test('a changed set of failing checks re-raises a held failed-check gate', async () => {
  // Same watched group, same head: shards 3 and 6 were fixed and shard 9 now fails.
  await held(async () => {
    snapshots.push(
      {
        checks: [failedCheck],
        allPassed: false,
        allFailedNames: ['Unit tests (3)', 'Unit tests (6)'],
      },
      { checks: [failedCheck], allPassed: false, allFailedNames: ['Unit tests (9)'] },
    );
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const first = await w.open('ci_ci_failed');
      assert.ok(first);
      resolveCIDecision(first.id, 'wait');
      await w.pollOnce();
      assert.ok(await w.open('ci_ci_failed'), 'the new failure is asked about');
    } finally {
      w.controller.abort();
    }
  }, null);
});

test('keep holding at a review-comments gate stays quiet for the same comments', async () => {
  await held(async () => {
    const commented = { checks: [passedCheck], allPassed: true, comments: [comment] };
    snapshots.push(commented, commented);
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const card = await w.open('ci_review_comments');
      assert.ok(card);
      assert.ok(
        card.actions.some((action) => action.id === 'wait' && action.label === 'Keep holding'),
      );
      resolveCIDecision(card.id, 'wait');
      await w.pollOnce();
      assert.equal(w.settled(), false);
      assert.deepEqual(w.openCards(), []);
    } finally {
      w.controller.abort();
    }
  }, null);
});

test('a held PR is not asked about early review comments on every poll', async () => {
  await held(async () => {
    const early = { checks: [pendingCheck], allPassed: false, comments: [comment] };
    snapshots.push(early, early);
    const w = watch((runId) => updateRun(runId, { decisions: [holdDecision(HELD_AT)] }));
    try {
      const card = await w.open('ci_review_comments_early');
      assert.ok(card);
      assert.ok(
        card.actions.some((action) => action.id === 'wait' && action.label === 'Keep holding'),
      );
      resolveCIDecision(card.id, 'wait');
      await w.pollOnce();
      assert.equal(w.settled(), false);
      assert.deepEqual(w.openCards(), []);
    } finally {
      w.controller.abort();
    }
  }, null);
});
