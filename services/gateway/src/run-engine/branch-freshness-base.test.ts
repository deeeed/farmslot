import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RunStack } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const exec = await import('../core/exec.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const scripts: string[] = [];
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ slotId: 'stacked-slot', remoteRepo: '/slot/repo' }),
    loadProjectVars: async () => ({ projectJson: { default_branch: 'main' } }),
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (_vars: unknown, script: string) => {
      scripts.push(script);
      return { stdout: '', stderr: '', exitCode: 1 };
    },
  },
});
// The lazily loaded stack lookup is imported here, so its cost isn't the test's.
await import('./stack-base.js');
// Loaded after the mocks, so its config and exec bindings are the mocked ones.
const freshModule: string = './branch-freshness.js?publication-base';
const { probeRunBaseFreshness } = (await import(
  freshModule
)) as typeof import('./branch-freshness.js');

test("the base probe uses the publication base: a stacked run's upstream branch, else the default (F302)", async () => {
  const stack: RunStack = {
    upstreamNodeId: 'node-a',
    upstreamRunId: 'run-a',
    baseBranch: 'feat/a',
    upstreamPrNumber: 41,
  };
  const run = { slotId: 'stacked-slot', project: 'demo', parentRunId: null };
  const stacked = await probeRunBaseFreshness({ ...run, stack });
  assert.deepEqual([stacked?.base, stacked?.defaultBranch], ['feat/a', 'main']);
  assert.match(scripts[0] ?? '', /feat\/a/);
  assert.doesNotMatch(scripts[0] ?? '', /origin\/main\b/);
  const plain = await probeRunBaseFreshness(run);
  assert.equal(plain?.base, 'main');
  assert.match(scripts[1] ?? '', /main/);
  assert.equal(await probeRunBaseFreshness({ ...run, slotId: null }), null);
});
