// Opt-in real Git QA prepare proof; exceeds the default per-test budget.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The shared fixture calls mock.module(...) and needs the module-mock test lane.
import {
  cleanTree,
  git,
  needsTmuxSandbox,
  slotFixture,
  slotPrepare,
} from './start-ref-on-current-branch.test-support.js';

// Regression: a QA dispatch to a slot already on the PR branch returned no
// start-ref provenance (the dispatch refused it) and would otherwise have
// reported the frozen head while the tree sat at origin/<branch>.
test(
  'qa: a slot already on the PR branch lands on the frozen head with provenance',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, frozenHead } = await slotFixture(t, 'warm', true, 48810);
    const events: Array<{ event: string; payload: unknown }> = [];
    const result = await slotPrepare(
      { slotId, branch: 'work', prepareProfile: 'core', flowType: 'qa' },
      (event, payload) => events.push({ event, payload }),
      undefined,
      { startRef: { requestedRef: frozenHead } },
    );
    assert.equal(result.prepared, true);
    assert.equal(result.startRef?.requestedRef, frozenHead, 'start ref provenance is missing');
    assert.equal(result.startRef?.resolvedSha, frozenHead);
    assert.equal(await git(slotRepo, 'branch', '--show-current'), 'work');
    assert.equal(
      await git(slotRepo, 'rev-parse', 'HEAD'),
      frozenHead,
      'the tree must sit at the frozen head, not at origin/work',
    );
    assert.deepEqual(await cleanTree(slotRepo), []);
    assert.match(JSON.stringify(events), /reset to requested start ref/);
  },
);

// A cold slot takes the fresh-branch path: the PR branch exists on origin, which
// the dev/fix-bug replay policy refuses, but a qa frozen head is not a replay.
test('qa: a cold slot checks out the PR branch at the frozen head', needsTmuxSandbox, async (t) => {
  const { slotId, slotRepo, frozenHead } = await slotFixture(t, 'cold', false, 48812);
  const result = await slotPrepare(
    { slotId, branch: 'work', prepareProfile: 'core', flowType: 'qa' },
    () => undefined,
    undefined,
    { startRef: { requestedRef: frozenHead } },
  );
  assert.equal(result.startRef?.resolvedSha, frozenHead);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'work');
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), frozenHead);
  assert.deepEqual(await cleanTree(slotRepo), []);
});
