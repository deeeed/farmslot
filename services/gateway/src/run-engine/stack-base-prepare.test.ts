// mock.module(...) in the shared fixture needs the test runner module-mock flag.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  git,
  needsTmuxSandbox,
  slotPrepare,
  stackFixture,
} from './stack-base-prepare.test-support.js';

test(
  'a stacked fix-bug branch starts from the upstream PR head fetched from origin',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, upstreamHead } = await stackFixture(t, 'stacked', 48830);
    const events: unknown[] = [];
    const recorded: string[] = [];
    const result = await slotPrepare(
      {
        slotId,
        branch: 'feat/stacked',
        prepareProfile: 'core',
        flowType: 'fix-bug',
        forceNewBranch: true,
      },
      (_event, payload) => events.push(payload),
      undefined,
      {
        stackBase: { requestedRef: 'refs/heads/feat/upstream' },
        onStackBaseResolved: async (resolution) => {
          recorded.push(resolution.resolvedSha);
        },
      },
    );
    assert.equal(result.stackBase?.resolvedSha, upstreamHead);
    assert.deepEqual(recorded, [upstreamHead], 'provenance is handed over as soon as it resolves');
    assert.equal(result.startRef, undefined, 'a stack base is not a replay start ref');
    assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/stacked');
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), upstreamHead);
    assert.match(JSON.stringify(events), /Created feat\/stacked from refs\/heads\/feat\/upstream/);
  },
);

test(
  'without a stack base the same prepare branches from the default branch',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, mainHead } = await stackFixture(t, 'plain', 48832);
    const result = await slotPrepare(
      {
        slotId,
        branch: 'feat/plain',
        prepareProfile: 'core',
        flowType: 'fix-bug',
        forceNewBranch: true,
      },
      () => undefined,
    );
    assert.equal(result.stackBase, undefined);
    assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/plain');
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), mainHead);
  },
);
