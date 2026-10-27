import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type { FinalizeStepContext } from '../run-engine/finalize-step.js';
import { makeReadyGatePackage } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

import { makeRun } from './test-fixtures.js';

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const branch = 'fix/publication';
const vars = makeVars({ remoteRepo: '/fixture', repo: '/fixture' });
let run: Run;
let remote: string;
let pushExit: number;
let pushAdvances: boolean;
let driftDuringBody: boolean;
let mergeExit: number | undefined;
let fetchOk: boolean;
let probeHead: string;
let conflictsDuringPush: boolean;
const commands: string[] = [];
const mutations: string[] = [];
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({
      projectJson: { default_branch: 'main', ci: { repo: 'fixture/repo', enabled: false } },
    }),
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execLocal: async () => ok(),
    execOnSlot: async (_vars: unknown, command: string) => {
      commands.push(command);
      if (command.includes('CONFLICT_EXIT:'))
        return ok(
          `HEAD:${probeHead}\nFETCH_OK:${fetchOk ? 1 : 0}\nREF_OK:1\nBEHIND:1\nAHEAD:1\nCONFLICT_EXIT:${mergeExit ?? 'unknown'}\nTREE_BEGIN\nconflict.txt\nTREE_END\n`,
        );
      if (command.includes('rev-parse HEAD')) return ok(head);
      if (command.includes('push -u origin')) {
        if (pushExit)
          return { stdout: 'hook refused', stderr: 'push rejected', exitCode: pushExit };
        if (pushAdvances) remote = head;
        if (conflictsDuringPush) mergeExit = 1;
        return ok();
      }
      if (command.includes('ls-remote')) return ok(`${remote}\trefs/heads/${branch}\n`);
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => (run = { ...run, ...patch }),
    updateRunStep: () => {},
  },
});
const linkage = await import('../integrations/pr-linkage.js');
mock.module('../integrations/pr-linkage.js', {
  namedExports: {
    ...linkage,
    findPRNumber: async () => 255,
    persistRunPrNumber: async () => {},
    recordRunPRPublication: async () => {
      mutations.push('record');
    },
  },
});
const output = await import('./output.js');
mock.module('./output.js', { namedExports: { ...output, captureRunOutput: async () => {} } });
const terminal = await import('../tasks/worker-terminal-contract.js');
mock.module('../tasks/worker-terminal-contract.js', {
  namedExports: { ...terminal, validateDeterministicChecksForRun: async () => [] },
});
const session = await import('../runners/session-process.js');
mock.module('../runners/session-process.js', {
  namedExports: { ...session, resolveRunnerSessionForRun: async () => null },
});
const usage = await import('../runtime/session-usage.js');
mock.module('../runtime/session-usage.js', {
  namedExports: { ...usage, extractRunnerSessionUsage: async () => ({}) },
});
const core = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...core, markSlotHeld: async () => {} } });
const fleet = await import('../fleet/state.js');
mock.module('../fleet/state.js', { namedExports: { ...fleet, loadFleetStatus: async () => ({}) } });
const publication = await import('./pr-publication.js');
mock.module('./pr-publication.js', {
  namedExports: {
    ...publication,
    updatePRTitle: async () => {
      mutations.push('title');
    },
    markPRReady: async () => {
      mutations.push('ready');
    },
  },
});
const artifacts = await import('./publication-artifacts.js');
mock.module('./publication-artifacts.js', {
  namedExports: {
    ...artifacts,
    postProcessPRBody: async () => {
      assert.equal(remote, head, 'Evidence must not be published ahead of origin');
      mutations.push('body');
      if (driftDuringBody) remote = old;
      return 'Published body';
    },
  },
});
const template = await import('./pr-template.js');
mock.module('./pr-template.js', {
  namedExports: { ...template, readGitHubPrTemplate: async () => null },
});
const github = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async () => {
      mutations.push('github');
      return ok();
    },
  },
});
const rerequest = await import('./review-rerequest.js');
mock.module('./review-rerequest.js', {
  namedExports: { ...rerequest, rerequestChangesRequestedReviewers: async () => [] },
});
const lifecycle = await import('../methods/run/lifecycle-control.js');
mock.module('../methods/run/lifecycle-control.js', {
  namedExports: { ...lifecycle, releaseCompletedRunSlot: async () => ({ released: true }) },
});
const pushModule = './publication-push.js?remote-head-fixture';
const push = await import(pushModule);
mock.module('./publication-push.js', { namedExports: push });
const completionModule = './orchestrator.js?remote-head-fixture';
const { publishCompletionPackage, runCompletionPipeline } = await import(completionModule);
const { assertPublicationRemoteHead, pushPublicationBranch } =
  await import('./publication-push.js');
const finalizeModule = '../run-engine/finalize-step.js?remote-head-fixture';
const { executeFinalizeStep } = await import(finalizeModule);
const context: FinalizeStepContext = {
  assertGatePrerequisites: async () => {},
  broadcastFn: () => {},
  latestResolvedHumanGateDecision: () => undefined,
  loadProjectVarsOrNull: async () => ({ projectJson: { ci: { repo: 'fixture/repo' } } }),
  readPreparedPackage: async () => undefined,
  refreshRunLinks: async () => {},
  stepPartialIO: new Map(),
};

beforeEach(() => {
  run = makeRun({
    id: 'publication-run',
    flowType: 'pr-complete',
    slotId: vars.slotId,
    branch,
    prNumber: 255,
    status: 'completing',
  });
  remote = old;
  pushExit = 0;
  pushAdvances = true;
  driftDuringBody = false;
  mergeExit = 0;
  fetchOk = true;
  probeHead = head;
  conflictsDuringPush = false;
  commands.length = 0;
  mutations.length = 0;
});

test('legacy completion pushes an existing PR before publishing its proof and records its HEAD', async () => {
  const result = await runCompletionPipeline(run.id, { skipRetrospective: true });
  assert.equal(result.publishedHeadSha, head);
  assert.equal(remote, head);
  assert.ok(commands.some((command) => command.includes('push -u origin')));
  assert.deepEqual(mutations, ['title', 'body', 'ready', 'record']);
});

for (const flow of ['pr-complete', 'dev', 'fix-bug', 'update-branch'] as const) {
  test(`${flow} push refusal stops publication before PR mutation`, async () => {
    run.flowType = flow;
    pushExit = 1;
    await assert.rejects(
      runCompletionPipeline(run.id, { skipRetrospective: true }),
      /git push.*failed/,
    );
    assert.deepEqual(mutations, []);
  });
}

test('local-first publication pushes an existing PR rather than only pushing during PR creation', async () => {
  run.flowType = 'dev';
  const result = await publishCompletionPackage(
    run.id,
    makeReadyGatePackage({ headSha: head, branch, publicationTarget: 'draft' }),
  );
  assert.equal(result.publishedHeadSha, head);
  assert.equal(result.publicationStatus, 'published_draft');
  assert.equal(remote, head);
  assert.ok(commands.some((command) => command.includes('push -u origin')));
});

for (const flow of ['pr-complete', 'dev', 'fix-bug', 'update-branch'] as const) {
  test(`${flow} publication refuses merge conflicts with CI disabled before pushing or posting`, async () => {
    run.flowType = flow;
    mergeExit = 1;
    await assert.rejects(
      publishCompletionPackage(run.id, makeReadyGatePackage({ headSha: head, branch })),
      /PUBLICATION_MERGE_CONFLICT/,
    );
    assert.deepEqual(mutations, []);
    assert.ok(!commands.some((command) => command.includes('push -u origin')));
    assert.equal(run.engineState?.publishGate?.publicationStatus, 'publish_failed');
  });
}

test('an unavailable merge probe cannot use the stale base as clean publication proof', async () => {
  fetchOk = false;
  await assert.rejects(
    publishCompletionPackage(run.id, makeReadyGatePackage({ headSha: head, branch })),
    /PUBLICATION_MERGEABILITY_UNAVAILABLE/,
  );
  assert.deepEqual(mutations, []);
});

test('publication binds the conflict probe to the approved HEAD', async () => {
  probeHead = old;
  await assert.rejects(
    publishCompletionPackage(run.id, makeReadyGatePackage({ headSha: head, branch })),
    /Publication HEAD drift/,
  );
  assert.deepEqual(mutations, []);
});

test('an unknown merge-tree result refuses publication before pushing or posting', async () => {
  mergeExit = undefined;
  await assert.rejects(
    publishCompletionPackage(run.id, makeReadyGatePackage({ headSha: head, branch })),
    /PUBLICATION_MERGEABILITY_UNAVAILABLE/,
  );
  assert.ok(!commands.some((command) => command.includes('push -u origin')));
  assert.deepEqual(mutations, []);
});

test('base conflicts introduced during push refuse PR mutation', async () => {
  conflictsDuringPush = true;
  await assert.rejects(
    publishCompletionPackage(run.id, makeReadyGatePackage({ headSha: head, branch })),
    /PUBLICATION_MERGE_CONFLICT/,
  );
  assert.equal(remote, head);
  assert.deepEqual(mutations, []);
});

test('legacy completion refuses conflicts before publishing', async () => {
  mergeExit = 1;
  await assert.rejects(
    runCompletionPipeline(run.id, { skipRetrospective: true }),
    /PUBLICATION_MERGE_CONFLICT/,
  );
  assert.deepEqual(mutations, []);
});

test('publication probes the given base and permits a clean branch behind it', async () => {
  await pushPublicationBranch(run, head, 'feature/upstream');
  const probes = commands.filter((command) => command.includes('CONFLICT_EXIT:'));
  assert.equal(probes.length, 2);
  assert.ok(probes.every((command) => command.includes('origin/feature/upstream')));
});

test('successful push exit with a stale actual remote refuses publication', async () => {
  pushAdvances = false;
  await assert.rejects(
    publishCompletionPackage(run.id, makeReadyGatePackage({ headSha: head, branch })),
    /remote HEAD mismatch/,
  );
  assert.equal(run.engineState?.publishGate?.publicationStatus, 'publish_failed');
  assert.deepEqual(mutations, []);
});

test('remote drift during PR mutation cannot record a successful publication', async () => {
  driftDuringBody = true;
  await assert.rejects(
    runCompletionPipeline(run.id, { skipRetrospective: true }),
    /remote HEAD mismatch/,
  );
  assert.ok(!mutations.includes('record'));
});

test('an optimistic local tracking ref cannot satisfy the actual remote check', async () => {
  await assert.rejects(assertPublicationRemoteHead(run, head), /remote HEAD mismatch/);
  assert.ok(commands.every((command) => command.includes('ls-remote')));
});

test('local HEAD drift refuses a push', async () => {
  await assert.rejects(pushPublicationBranch(run, old, 'main'), /Publication HEAD drift/);
  assert.ok(!commands.some((command) => command.includes('push -u origin')));
});

function recordComplete() {
  run.steps = [{ name: 'complete', status: 'done', outputs: { publishedHeadSha: head } }];
}

test('legacy finalize refuses a remote behind its completion publication HEAD', async () => {
  recordComplete();
  await assert.rejects(executeFinalizeStep(run.id, context), /remote HEAD mismatch/);
});

test('legacy finalize succeeds only when origin matches the recorded completion HEAD', async () => {
  recordComplete();
  remote = head;
  const result = await executeFinalizeStep(run.id, context);
  assert.equal(result.outputs?.publishedHeadSha, head);
});

test('retained legacy completion without a publication HEAD requires replay instead of guessing HEAD', async () => {
  remote = head;
  await assert.rejects(executeFinalizeStep(run.id, context), /replay complete before finalize/);
});

for (const disposition of ['already_fixed', 'not_reproducible'] as const) {
  test(`${disposition} finalize does not push or require a publication HEAD`, async () => {
    run.metrics.disposition = disposition;
    await executeFinalizeStep(run.id, context);
    assert.equal(commands.length, 0);
  });
}

test('artifact-only finalize does not require branch publication', async () => {
  run.completionPolicy = 'artifact-only';
  await executeFinalizeStep(run.id, context);
  assert.equal(commands.length, 0);
});
