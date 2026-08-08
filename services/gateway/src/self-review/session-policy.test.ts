import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  claimWarmReviewerSession,
  DEFAULT_REVIEW_SESSION_POLICY,
  invalidateWarmReviewerSessions,
  invalidateWarmReviewerSessionsForSlot,
  parseReviewSessionPolicy,
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

test('policy parsing accepts the two modes and defaults everything else to fresh', () => {
  assert.equal(parseReviewSessionPolicy('fresh-per-pass'), 'fresh-per-pass');
  assert.equal(parseReviewSessionPolicy('warm-per-reviewer'), 'warm-per-reviewer');
  assert.equal(parseReviewSessionPolicy(undefined), undefined);
  assert.equal(parseReviewSessionPolicy(null), undefined);
  assert.equal(parseReviewSessionPolicy('warm'), undefined);
  assert.equal(parseReviewSessionPolicy(1), undefined);
  assert.equal(DEFAULT_REVIEW_SESSION_POLICY, 'fresh-per-pass');
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
