import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  claimWarmReviewerSession,
  DEFAULT_REVIEW_SESSION_POLICY,
  invalidateWarmReviewerSessions,
  invalidateWarmReviewerSessionsForSlot,
  parseReviewSessionPolicy,
  persistedWarmReviewerSession,
  registerWarmReviewerSession,
  resetWarmReviewerSessionsForTest,
  shouldAttemptWarmResume,
  type WarmReviewerScope,
} from './session-policy.js';
import { reviewArtifactDir } from './snapshots.js';

const scope: WarmReviewerScope = {
  runId: 'run-a',
  taskDir: '.sandbox/proj/worker-task/feat/x',
  artifactScope: null,
  runner: 'codex',
  subjectRef: 'feat/x',
};

function register(
  loopNumber = 1,
  overrides: Partial<Parameters<typeof registerWarmReviewerSession>[0]> = {},
) {
  registerWarmReviewerSession({
    ...scope,
    contextId: 'rev-codex',
    windowName: 'rev-codex',
    slotId: 'slot-1',
    runnerSessionId: `sess-${loopNumber}`,
    runnerSessionPath: null,
    lastLoopNumber: loopNumber,
    lastReviewedHeadSha: `head-${loopNumber}`,
    ...overrides,
  });
}

beforeEach(() => resetWarmReviewerSessionsForTest());

test('policy parsing accepts the two modes, rejects everything else, and the default is warm', () => {
  assert.equal(parseReviewSessionPolicy('fresh-per-pass'), 'fresh-per-pass');
  assert.equal(parseReviewSessionPolicy('warm-per-reviewer'), 'warm-per-reviewer');
  assert.equal(parseReviewSessionPolicy(undefined), undefined);
  assert.equal(parseReviewSessionPolicy(null), undefined);
  assert.equal(parseReviewSessionPolicy('warm'), undefined);
  assert.equal(parseReviewSessionPolicy(1), undefined);
  // Warm is the default: re-reviews resume the reviewer's context instead of
  // rebuilding the whole review after every worker fix.
  assert.equal(DEFAULT_REVIEW_SESSION_POLICY, 'warm-per-reviewer');
  // The default engages warm resume exactly where it matters: loop > 1 with a
  // reload-capable runner. First passes and no-reload runners stay cold.
  assert.equal(shouldAttemptWarmResume(DEFAULT_REVIEW_SESSION_POLICY, 2, true), true);
  assert.equal(shouldAttemptWarmResume(DEFAULT_REVIEW_SESSION_POLICY, 1, true), false);
  assert.equal(shouldAttemptWarmResume(DEFAULT_REVIEW_SESSION_POLICY, 2, false), false);
});

test('fresh-per-pass preserves cold relaunch behavior and never attempts resume', () => {
  for (const loopNumber of [1, 2, 3, 5]) {
    assert.equal(shouldAttemptWarmResume('fresh-per-pass', loopNumber, true), false);
  }
  // Even with a registered session in scope, fresh passes never look it up —
  // review-agent only calls claim when shouldAttemptWarmResume is true.
  register(1);
  assert.equal(shouldAttemptWarmResume('fresh-per-pass', 2, true), false);
});

test('warm-per-reviewer resumes only from loop 2 on reload-capable runners', () => {
  assert.equal(shouldAttemptWarmResume('warm-per-reviewer', 1, true), false); // nothing to resume
  assert.equal(shouldAttemptWarmResume('warm-per-reviewer', 2, true), true);
  assert.equal(shouldAttemptWarmResume('warm-per-reviewer', 2, false), false); // e.g. cursor
});

test('a non-reloadable runner under warm policy never resumes', () => {
  for (const loopNumber of [1, 2, 3]) {
    assert.equal(shouldAttemptWarmResume('warm-per-reviewer', loopNumber, false), false);
  }
});

test('warm claim rejects reuse when any scope field differs', () => {
  register(1);
  assert.ok(claimWarmReviewerSession(scope), 'exact scope must claim');
  assert.equal(claimWarmReviewerSession({ ...scope, runId: 'run-b' }), null);
  assert.equal(
    claimWarmReviewerSession({ ...scope, taskDir: '.sandbox/proj/worker-task/feat/y' }),
    null,
  );
  assert.equal(claimWarmReviewerSession({ ...scope, artifactScope: 'extra-review-1' }), null);
  assert.ok(
    claimWarmReviewerSession(
      { ...scope, artifactScope: 'extra-review-1' },
      { allowArtifactScopeChange: true },
    ),
  );
  assert.equal(claimWarmReviewerSession({ ...scope, runner: 'claude' }), null);
  assert.equal(claimWarmReviewerSession({ ...scope, subjectRef: 'feat/other' }), null);
});

test('one reviewer session spans review → fix → re-review while loop artifacts stay separate', () => {
  register(1);
  const loop2 = claimWarmReviewerSession(scope);
  assert.equal(loop2?.runnerSessionId, 'sess-1');
  assert.equal(loop2?.contextId, 'rev-codex');
  // The resumed pass re-registers (possibly with a runner-minted follow-up id).
  register(2, { runnerSessionId: 'sess-1' });
  const loop3 = claimWarmReviewerSession(scope);
  assert.equal(loop3?.runnerSessionId, 'sess-1');
  assert.equal(loop3?.lastLoopNumber, 2);
  // Per-loop artifact directories never collapse under warm reuse.
  assert.notEqual(reviewArtifactDir(1, null), reviewArtifactDir(2, null));
  assert.notEqual(reviewArtifactDir(2, 'extra-review-1'), reviewArtifactDir(2, null));
});

test('registration requires a runner session id', () => {
  assert.throws(() => register(1, { runnerSessionId: '  ' }), /requires a runner session id/);
});

test('review-gate exit / run completion / cancel invalidation makes sessions forensic-only', () => {
  register(1);
  assert.equal(invalidateWarmReviewerSessions('run-a'), 1);
  assert.equal(claimWarmReviewerSession(scope), null);
  // Idempotent: already-forensic sessions are not re-counted.
  assert.equal(invalidateWarmReviewerSessions('run-a'), 0);
  // Re-registering after invalidation (a NEW review loop on the same run) works.
  register(1);
  assert.ok(claimWarmReviewerSession(scope));
});

test('runner-scoped invalidation ends one reviewer loop without touching another runner', () => {
  register(1); // codex
  registerWarmReviewerSession({
    ...scope,
    runner: 'claude',
    contextId: 'rev-claude',
    windowName: 'rev-claude',
    slotId: 'slot-1',
    runnerSessionId: 'sess-claude',
    runnerSessionPath: null,
    lastLoopNumber: 1,
    lastReviewedHeadSha: 'head-1',
  });
  // Codex review loop exits: only the codex session turns forensic.
  assert.equal(invalidateWarmReviewerSessions('run-a', 'codex'), 1);
  assert.equal(claimWarmReviewerSession(scope), null);
  assert.ok(claimWarmReviewerSession({ ...scope, runner: 'claude' }));
  // Run-wide invalidation (cancel) still ends everything.
  assert.equal(invalidateWarmReviewerSessions('run-a'), 1);
  assert.equal(claimWarmReviewerSession({ ...scope, runner: 'claude' }), null);
});

test('slot release invalidates every warm session on the slot', () => {
  register(1);
  registerWarmReviewerSession({
    ...scope,
    runId: 'run-b',
    contextId: 'rev-claude',
    windowName: 'rev-claude',
    slotId: 'slot-1',
    runner: 'claude',
    runnerSessionId: 'sess-x',
    runnerSessionPath: null,
    lastLoopNumber: 1,
    lastReviewedHeadSha: 'head-1',
  });
  assert.equal(invalidateWarmReviewerSessionsForSlot('slot-1'), 2);
  assert.equal(claimWarmReviewerSession(scope), null);
  assert.equal(claimWarmReviewerSession({ ...scope, runId: 'run-b', runner: 'claude' }), null);
});

test("a later unrelated run can never claim another run's session", () => {
  register(1);
  // Same slot, same runner, same task dir — but a different run.
  assert.equal(claimWarmReviewerSession({ ...scope, runId: 'run-later' }), null);
});

test('explicit continuation recovers a completed same-run reviewer after registry loss', () => {
  const nextScope = { ...scope, artifactScope: 'independent-review-3' };
  const run: Parameters<typeof persistedWarmReviewerSession>[1] = {
    id: scope.runId,
    status: 'human-gating',
    slotId: 'slot-1',
    branch: scope.subjectRef,
    agentContexts: [
      {
        id: 'rev-codex',
        role: 'self-review',
        label: 'Reviewer',
        runner: scope.runner,
        runId: scope.runId,
        slotId: 'slot-1',
        status: 'complete',
        artifactScope: 'independent-review-2',
        taskFile: `${scope.taskDir}/SELF-REVIEW.rev-codex.md`,
        runnerSessionId: 'sess-persisted',
        runnerSessionPath: '/sessions/sess-persisted.jsonl',
        runnerSessionCapturedAt: '2026-09-30T00:00:00.000Z',
        reviewLoopNumber: 2,
        target: { session: 'slot', window: 'rev-codex', pane: null, target: 'slot:rev-codex' },
      },
    ],
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-2',
            source: 'human-gate',
            runner: scope.runner,
            model: 'gpt-6-sol',
            crossRunner: true,
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewerSessionId: 'sess-persisted',
            reviewSnapshot: {
              source: 'local-git',
              headRef: scope.subjectRef,
              headSha: 'head-2',
              capturedAt: '2026-09-30T00:00:00.000Z',
            },
          },
        ],
      },
    },
  };
  assert.equal(persistedWarmReviewerSession(nextScope, run)?.runnerSessionId, 'sess-persisted');
  assert.equal(persistedWarmReviewerSession(nextScope, run)?.artifactScope, 'independent-review-2');
  assert.equal(persistedWarmReviewerSession({ ...nextScope, runId: 'other-run' }, run), null);
  assert.equal(persistedWarmReviewerSession({ ...nextScope, taskDir: 'other-task' }, run), null);
  assert.equal(
    persistedWarmReviewerSession({ ...nextScope, subjectRef: 'other-branch' }, run),
    null,
  );
  assert.equal(persistedWarmReviewerSession({ ...nextScope, runner: 'claude' }, run), null);
  assert.equal(persistedWarmReviewerSession(nextScope, { ...run, slotId: 'other-slot' }), null);
  assert.equal(persistedWarmReviewerSession(nextScope, { ...run, status: 'cancelled' }), null);
  assert.equal(
    persistedWarmReviewerSession(nextScope, {
      ...run,
      agentContexts: run.agentContexts!.map((context) => ({ ...context, runnerSessionPath: null })),
    }),
    null,
  );
  assert.equal(
    persistedWarmReviewerSession(nextScope, {
      ...run,
      resourcePosture: {
        posture: 'terminal',
        policySource: 'framework-default',
        capabilities: [],
        workerRetained: false,
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
    }),
    null,
  );
  register(2);
  invalidateWarmReviewerSessions(scope.runId);
  assert.equal(persistedWarmReviewerSession(nextScope, run), null);
});
