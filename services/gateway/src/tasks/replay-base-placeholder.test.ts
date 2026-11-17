import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');

// Eval run 9317844e (comparison lane, variant glm-lite, dev/core, artifact-only)
// had startRef: null, so TASK.md was generated with the literal fallback string:
//
//   This task is an artifact-only comparison replay from `selected reference/base`.
//   ... compare against the replay base: `git diff selected reference/base`
//
// The worker then went looking for the ref the farm text named — `git branch -a
// | grep reference`, `git rev-parse 'selected reference/base'` — a git-history
// probe that a blind trial must never invite. The run did carry its base: the
// record has preWorkBaseSha, worktreeHeadAtDispatch and prepare's baseSha all
// equal to 49426fdf906f2663d8306a299aad94f77f6ca323.
const recordedBase = '49426fdf906f2663d8306a299aad94f77f6ca323';

const comparisonReplayRun = (overrides: Partial<Run> = {}) =>
  ({
    completionPolicy: 'artifact-only',
    flowType: 'dev',
    lane: 'comparison',
    variant: 'glm-lite',
    startRef: null,
    preWorkBaseSha: recordedBase,
    worktreeHeadAtDispatch: recordedBase,
    engineState: {},
    ...overrides,
  }) as unknown as Run;

const { artifactOnlyReplayForRun } = await import('./writer.js');

test('an artifact-only replay takes its base from the recorded pre-work base', async () => {
  const replay = artifactOnlyReplayForRun(comparisonReplayRun());
  assert.equal(replay?.base, recordedBase);
});

test('an artifact-only replay falls back to the dispatch head', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({ preWorkBaseSha: undefined } as Partial<Run>),
  );
  assert.equal(replay?.base, recordedBase);
});

test('a replay with no recorded base declares no base at all', async () => {
  const replay = artifactOnlyReplayForRun(
    comparisonReplayRun({
      preWorkBaseSha: undefined,
      worktreeHeadAtDispatch: undefined,
    } as Partial<Run>),
  );
  assert.equal(
    replay?.base,
    undefined,
    'a placeholder in TASK.md sends the worker hunting for a ref that does not exist',
  );
});

test('no generated replay base is ever a placeholder string', async () => {
  for (const run of [
    comparisonReplayRun(),
    comparisonReplayRun({ preWorkBaseSha: undefined } as Partial<Run>),
    comparisonReplayRun({
      preWorkBaseSha: undefined,
      worktreeHeadAtDispatch: undefined,
    } as Partial<Run>),
  ]) {
    const base = artifactOnlyReplayForRun(run)?.base;
    if (base === undefined) continue;
    assert.match(
      base,
      /^[a-f0-9]{40}$|^[\w./-]+$/u,
      `a replay base must be a resolvable ref, never prose: ${base}`,
    );
    assert.equal(base.includes(' '), false, `a replay base must not contain spaces: ${base}`);
  }
});
