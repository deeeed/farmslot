import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';
import { fakeGitHubService } from '../integrations/github-test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');

// TAT-4644: the worker reused a branch whose PR (#388) was already merged.
// Publication bound that merged PR, pushed the new head onto its branch and
// marked the run done against it, so the work never got a PR of its own.
const head = 'a'.repeat(40);
const merged = {
  number: 388,
  state: 'MERGED',
  headRefOid: 'b'.repeat(40),
  mergedAt: '2026-11-17T21:04:00Z',
};
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
  return {
    stdout: command.includes('CONFLICT_EXIT:')
      ? `HEAD:${head}\nFETCH_OK:1\nREF_OK:1\nBEHIND:0\nAHEAD:1\nCONFLICT_EXIT:0\nTREE_BEGIN\nTREE_END\n`
      : command.includes('rev-parse HEAD')
        ? head
        : command.includes('ls-remote')
          ? `${head}\trefs/heads/TAT-4644-feat-terminal-reused\n`
          : '',
    stderr: '',
    exitCode: 0,
  };
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
const mergedFakeGithub = fakeGitHubService(github.github, {
  prView: async (_repo, number) => {
    calls.push(['pr', 'view', String(number)]);
    assert.equal(number, merged.number, 'prView should only be called for the merged PR');
    return { ...merged };
  },
  prListFields: async (_repo, _fields, params) => {
    const isAll = params.state === 'all';
    calls.push(isAll ? ['pr', 'list', 'all'] : ['pr', 'list']);
    // No open PR on the branch; the all-states fallback finds only the merged one.
    return isAll ? [{ ...merged }] : [];
  },
  prCreate: async () => {
    calls.push(['pr', 'create']);
    return 'https://github.com/owner/repo/pull/390';
  },
  prEdit: async (_repo, prNumber, _params) => {
    calls.push(['pr', 'edit', String(prNumber)]);
    assert.notEqual(prNumber, merged.number, 'Never edit the merged PR');
    return '';
  },
  prComment: async (_repo, prNumber) => {
    calls.push(['pr', 'comment', String(prNumber)]);
    assert.notEqual(prNumber, merged.number, 'Never comment on the merged PR');
    return '';
  },
  rest: async (_method: string, path: string) => {
    calls.push(['api', path]);
    if (path.includes('/contents/')) throw new Error('HTTP 404 Not Found');
    return {};
  },
});
mock.module('../integrations/github-client.js', {
  namedExports: { ...github, github: mergedFakeGithub },
});
// findPRNumber wraps its branch search in try/catch, so a throwing mock here
// would be swallowed and read as a miss. Record instead and assert after.
const bindings: number[] = [];
mock.module('../integrations/github-bindings-cache.js', {
  namedExports: {
    getBinding: () => null,
    setBinding: (_branch: string, _repo: string, prNumber: number) => {
      bindings.push(prNumber);
    },
    invalidateBinding: () => {},
  },
});
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('../run-engine/test-fixtures.js');
const { publishCompletionPackage } = await import('./orchestrator.js');

const publish = async (
  t: { after: (fn: () => void) => void },
  overrides: Record<string, unknown>,
) => {
  calls.length = 0;
  commands.length = 0;
  bindings.length = 0;
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: vars.projectName,
    ticketOrPr: 'TAT-4644',
    branch: 'TAT-4644-feat-terminal-reused',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    slotId: vars.slotId,
    worktreeHeadAtDispatch: merged.headRefOid,
    engineState: { publishGate: { publicationStatus: 'publish_failed' } },
    ...overrides,
  });
  const result = await publishCompletionPackage(
    run.id,
    makeReadyGatePackage({
      branch: run.branch!,
      headSha: head,
      publicationTarget: 'draft',
    }),
  );
  return { run, result };
};

test('publication opens its own PR when the branch search only finds a merged PR', async (t) => {
  const { run, result } = await publish(t, {});
  assert.equal(result.prNumber, 390, 'the run must publish to a PR of its own, not merged #388');
  assert.equal(result.publicationStatus, 'published_draft');
  assert.equal(getRun(run.id)?.prNumber, 390);
  assert.deepEqual(
    getRun(run.id)?.prPublications?.map(({ pr }) => pr.number),
    [390],
  );
  assert.equal(calls.filter((args) => args[1] === 'create').length, 1);
  assert.equal(
    calls.some((args) => args[2] === String(merged.number) && args[1] !== 'view'),
    false,
    'no mutation may land on the merged PR',
  );
  assert.equal(
    bindings.includes(merged.number),
    false,
    'a merged PR may never be cached as the run binding',
  );
});

test('publication opens its own PR when the run has a merged PR number saved', async (t) => {
  const { run, result } = await publish(t, { prNumber: merged.number });
  assert.equal(result.prNumber, 390, 'a saved merged PR number must not be reused');
  assert.equal(getRun(run.id)?.prNumber, 390);
  assert.equal(calls.filter((args) => args[1] === 'create').length, 1);
});
