import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');

// Eval run 9317844e (comparison lane, variant glm-lite, dev/core, artifact-only)
// was dispatched without a startRef, so TASK.md was generated with the
// gateway's prose fallback:
//
//   This task is an artifact-only comparison replay from `selected reference/base`.
//   ... compare against the replay base: `git diff selected reference/base`
//
// The worker did what the task text said and went looking for that ref — `git
// branch -a | grep reference`, `git rev-parse 'selected reference/base'` — a
// git-history probe a blind trial must never invite.
//
// The run's recorded base (preWorkBaseSha / worktreeHeadAtDispatch) is NOT a
// substitute: FLOW_STEPS runs WRITE_TASK before PREPARE and DISPATCH, and this
// run proves the timing — write-task at 16:55:32Z, TASK.md written 17:00:13Z,
// dispatch (which records the base) at 17:00:30Z. At generation time there is
// no base to name unless the operator froze one as startRef.
const frozenBase = '49426fdf906f2663d8306a299aad94f77f6ca323';

const comparisonReplayRun = (overrides: Partial<Run> = {}) =>
  ({
    completionPolicy: 'artifact-only',
    flowType: 'dev',
    lane: 'comparison',
    variant: 'glm-lite',
    startRef: null,
    engineState: {},
    ...overrides,
  }) as unknown as Run;

const { artifactOnlyReplayForRun } = await import('./writer.js');

test('an artifact-only replay names the frozen startRef sha', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({
      startRef: { requestedRef: 'main', resolvedSha: frozenBase, source: { kind: 'manual' } },
    } as Partial<Run>),
  );
  assert.equal(replay?.base, frozenBase);
});

test('an artifact-only replay falls back to the requested ref', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({
      startRef: { requestedRef: 'v1.2.3', source: { kind: 'manual' } },
    } as Partial<Run>),
  );
  assert.equal(replay?.base, 'v1.2.3');
});

test('a replay with no frozen base declares no base at all', async () => {
  const replay = artifactOnlyReplayForRun(comparisonReplayRun());
  assert.equal(
    replay?.base,
    undefined,
    'a placeholder in TASK.md sends the worker hunting for a ref that does not exist',
  );
});

// The fields recorded after WRITE_TASK must not be read here even when a
// regenerated task file would see them: on a replayed dispatch
// worktreeHeadAtDispatch can have moved past the candidate's own commits, so
// naming it would silently drop them from the comparison.
test('a replay ignores bases recorded after the task input was frozen', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({
      preWorkBaseSha: frozenBase,
      worktreeHeadAtDispatch: frozenBase,
    } as Partial<Run>),
  );
  assert.equal(replay?.base, undefined);
});

// A capsule blind trial carries its base before write-task, and prepare checks
// the capsule out at exactly that commit, so it is the worker's real starting
// point rather than an inference about where the branch ended up.
test('a capsule blind trial names the base prepare checks it out at', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({
      engineState: {
        evalExperiment: {
          blind: { version: 1, baseSha: frozenBase, referenceCommits: [], forbiddenInputs: [] },
        },
      },
    } as Partial<Run>),
  );
  assert.equal(replay?.base, frozenBase);
});

// A normal-slot trial is not checked out at that sha by prepare, so naming it
// would compare against a commit the worktree may never have been on.
test('a normal-slot blind trial declares no base', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({
      engineState: {
        evalExperiment: {
          blind: {
            version: 1,
            executionPolicy: 'normal-slot',
            baseSha: frozenBase,
            referenceCommits: [],
            forbiddenInputs: [],
          },
        },
      },
    } as Partial<Run>),
  );
  assert.equal(replay?.base, undefined);
});

test('no generated replay base is ever a placeholder string', async () => {
  for (const run of [
    comparisonReplayRun(),
    comparisonReplayRun({
      startRef: { requestedRef: 'main', resolvedSha: frozenBase, source: { kind: 'manual' } },
    } as Partial<Run>),
  ]) {
    const base = artifactOnlyReplayForRun(run)?.base;
    if (base === undefined) continue;
    assert.equal(base.includes(' '), false, `a replay base must not contain spaces: ${base}`);
  }
});
