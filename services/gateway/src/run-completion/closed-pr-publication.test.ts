import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');

const head = 'a'.repeat(40);
const historical = { number: 193, state: 'CLOSED', headRefOid: 'b'.repeat(40) };
const calls: string[][] = [];
const commands: string[] = [];
const vars: SlotVars = {
  slotId: 'publication-fixture',
  machine: 'fixture',
  host: 'localhost',
  repo: '/fixture',
  remoteRepo: '/fixture',
  projectName: 'publication-fixture',
  platform: 'cli',
  sshUser: '',
  osType: 'linux',
  claudePath: '',
  codexPath: '',
  cursorPath: '',
  grokPath: '',
  opencodePath: '',
  dispatchCmd: '',
  recycleCmd: '',
  session: 'fixture',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  resourceVars: {},
};
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({
      projectJson: { default_branch: 'main', ci: { repo: 'owner/repo' } },
    }),
  },
});
const execution = await import('../core/exec.js');
const execute = async (_vars: SlotVars, command: string) => {
  commands.push(command);
  return { stdout: command.includes('rev-parse HEAD') ? head : '', stderr: '', exitCode: 0 };
};
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: execute,
  },
});
const core = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...core, execOnSlot: execute } });
const github = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      calls.push(args);
      const ok = (value = '') => ({ stdout: value, stderr: '' });
      if (args[0] === 'api') return ok('{}');
      if (args[1] === 'view') {
        assert.equal(args[2], String(historical.number));
        return ok(JSON.stringify(historical));
      }
      if (args[1] === 'list') return ok(JSON.stringify(args.includes('all') ? [historical] : []));
      if (args[1] === 'create') return ok('https://github.com/owner/repo/pull/194');
      assert.deepEqual(args.slice(0, 3), ['pr', 'edit', '194'], 'Never edit the historical PR');
      return ok();
    },
  },
});
mock.module('../integrations/github-bindings-cache.js', {
  namedExports: {
    getBinding: () => null,
    setBinding: () => assert.fail('No historical binding may be cached'),
    invalidateBinding: () => {},
  },
});
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('../run-engine/test-fixtures.js');
const { publishCompletionPackage } = await import('./orchestrator.js');

test('finalize retry creates and persists a fresh PR without editing its unrelated saved PR', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: vars.projectName,
    ticketOrPr: 'PROJ-1',
    branch: 'fix/reused',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    slotId: vars.slotId,
    prNumber: historical.number,
    worktreeHeadAtDispatch: historical.headRefOid,
    engineState: { publishGate: { publicationStatus: 'publish_failed' } },
  });
  const result = await publishCompletionPackage(
    run.id,
    makeReadyGatePackage({
      branch: run.branch!,
      headSha: head,
      publicationTarget: 'draft',
    }),
  );
  assert.equal(result.prNumber, 194);
  assert.equal(result.publicationStatus, 'published_draft');
  assert.equal(getRun(run.id)?.prNumber, 194);
  assert.deepEqual(
    getRun(run.id)?.prPublications?.map(({ pr }) => pr.number),
    [194],
  );
  assert.equal(calls.filter((args) => args[1] === 'create').length, 1);
  assert.equal(
    calls.some((args) => args[1] === 'edit' && args[2] === String(historical.number)),
    false,
  );
  assert.ok(commands.some((command) => command.includes('push -u origin')));
});
