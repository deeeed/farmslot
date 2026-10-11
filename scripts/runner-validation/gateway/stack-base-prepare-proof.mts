// Run with NODE_TEST_CONTEXT=1 and an existing guarded tmux socket:
// TMUX_TMPDIR=<socket-parent> FARMSLOT_TMUX_SANDBOX=<socket> node --import tsx --experimental-test-module-mocks scripts/runner-validation/gateway/stack-base-prepare-proof.mts
// Manual live tier: these real-tmux prepare cases take over five seconds.
// Run only against an existing owned-session tmux socket; never start or kill a server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after } from 'node:test';
import { test } from 'node:test';

import {
  git,
  tmuxSandbox,
  slotPrepare,
  stackFixture,
} from '../../../services/gateway/src/run-engine/stack-base-prepare.test-support.js';

assert.ok(tmuxSandbox, 'An existing guarded tmux socket is required; this manual proof must run');
const serverPid = () =>
  execFileSync('tmux', ['-N', '-S', tmuxSandbox!, 'display-message', '-p', '#{pid}'], {
    encoding: 'utf8',
  }).trim();
const originalServerPid = serverPid();
assert.match(originalServerPid, /^[1-9][0-9]*$/, 'The guarded tmux server must already be running');
after(() =>
  assert.equal(serverPid(), originalServerPid, 'Cleanup must preserve the existing tmux server'),
);

test('a reused linked worktree on the work branch still lands on the stack base', async (t) => {
  const { slotId, slotRepo, upstreamHead } = await stackFixture(t, 'linked', 48834, {
    linkedWorktreeOn: 'feat/stacked',
  });
  const result = await slotPrepare(
    {
      slotId,
      branch: 'feat/stacked',
      prepareProfile: 'core',
      flowType: 'fix-bug',
      forceNewBranch: true,
    },
    () => undefined,
    undefined,
    { stackBase: { requestedRef: 'refs/heads/feat/upstream' } },
  );
  assert.equal(result.stackBase?.resolvedSha, upstreamHead);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/stacked');
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), upstreamHead);
});

test('a stacked fix-bug branch starts from the upstream PR head fetched from origin', async (t) => {
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
});

test('without a stack base the same prepare branches from the default branch', async (t) => {
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
});
