import assert from 'node:assert/strict';
import { test } from 'node:test';

// The shared fixture calls mock.module(...) and needs the module-mock test lane.
import {
  git,
  needsTmuxSandbox,
  slotFixture,
  slotPrepare,
} from './start-ref-on-current-branch.test-support.js';

// For dev/fix-bug the start ref is an artifact-only replay base and the work
// branch must stay local-only, on the already-on-branch path as on the fresh one.
test(
  'dev: a remote-published branch already checked out is refused for a start ref',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, frozenHead, laterHead } = await slotFixture(t, 'policy', true, 48814);
    await assert.rejects(
      slotPrepare(
        { slotId, branch: 'work', prepareProfile: 'core', flowType: 'dev' },
        () => undefined,
        undefined,
        { startRef: { requestedRef: frozenHead } },
      ),
      /refuses to mutate or reuse existing remote branch/,
    );
    assert.equal(
      await git(slotRepo, 'rev-parse', 'HEAD'),
      laterHead,
      'a refused prepare must not rewind the branch',
    );
  },
);
