import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { ReadyGatePayload, ReviewSelection } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';

const nativeConfig = await import('../core/config.js');
const nativeExec = await import('../core/exec.js');
const nativeState = await import('../core/state.js');

let repo = '';
let slotOwner = '';
let githubRequests = 0;
const slotCommands: string[] = [];
mock.module('../core/config.js', {
  namedExports: {
    ...nativeConfig,
    loadSlotVars: async () =>
      makeVars({ slotId: 'headline', projectName: 'example-headline', remoteRepo: repo, repo }),
    loadProjectVars: async () => ({
      projectJson: {
        name: 'example-headline',
        default_branch: 'main',
        paths: { artifact_dir: '.task' },
      },
      runtimeDir: '.agent',
      artifactDir: '.task',
    }),
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...nativeExec,
    execOnSlot: async (_vars: unknown, command: string) => {
      assert.ok(!command.includes('tmux'), 'the fixture never invokes a real runner');
      slotCommands.push(command);
      return nativeExec.execLocal(command, { cwd: repo });
    },
  },
});
mock.module('../core/state.js', {
  namedExports: {
    ...nativeState,
    readSlotRow: async () => ({ current_run_id: slotOwner, slot_epoch: 1 }),
  },
});
const { isTerminalReviewArtifactError, TerminalReviewArtifactError } =
  await import('../review/terminal-result.js');
// No spread of the real exports: importing this module first would load post-dispatch-steps,
// on its import cycle, before the mock exists.
mock.module('./recover-inflight-reviews.js', {
  namedExports: {
    isTerminalReviewArtifactError,
    TerminalReviewArtifactError,
    normalizeExhaustedReviewContinuationsForRun: () => [],
    projectExhaustedReviewContinuationsForRun: () => [],
    publicationReviewRecoveryNeedsReplay: () => false,
    reviewerContextNeedsRecovery: () => false,
    recoverInflightPublicationReviews: async () => ({
      recoveredIds: ['recovered-review'],
      terminalErrors: [],
    }),
  },
});
// Imported after the mocks above: these reach the real diff capture, which must bind them.
const nativeGithub = await import('../integrations/github-client.js');
const nativeMirror = await import('../run-completion/artifact-mirror.js');
const nativeDraft = await import('../run-completion/draft-pr.js');
const nativeTemplate = await import('../run-completion/pr-template.js');
const nativeSession = await import('../runners/session-process.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...nativeGithub,
    ghRequest: async () => {
      githubRequests++;
      throw new Error('The gate headline fixture never reaches GitHub');
    },
  },
});
mock.module('../run-completion/artifact-mirror.js', {
  namedExports: { ...nativeMirror, refreshArtifactMirror: async () => 1 },
});
mock.module('../run-completion/draft-pr.js', {
  namedExports: { ...nativeDraft, buildDraftPrBody: async () => '## Summary\nFix\n' },
});
mock.module('../run-completion/pr-template.js', {
  namedExports: {
    ...nativeTemplate,
    conformRunPrBodyToTemplate: async (_run: unknown, body: string) => ({
      body,
      added: [],
      outOfOrder: [],
    }),
  },
});
mock.module('../runners/session-process.js', {
  namedExports: { ...nativeSession, resolveRunnerSessionForRun: async () => null },
});
const nativeFleet = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: { ...nativeFleet, loadFleetStatus: async () => ({ machines: [] }) },
});

const { prepareCompletionPackage } = await import('../run-completion/orchestrator.js');
const { readReadyGatePreparedPackage } = await import('../run-completion/ready-gate-package.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { executeCompleteStep, executeHumanGateStep, reconcilePublishGateReviewPlanResult } =
  await import('./post-dispatch-steps.js');
const { executeReadyGate } = await import('./ready-gate.js');
const { getDiffStat } = await import('./task-artifacts.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');

type StepContext = import('./post-dispatch-steps.js').PostDispatchStepContext;

const root = await mkdtemp(path.join(tmpdir(), 'gate-diff-headline-'));
const runIds: string[] = [];
after(async () => {
  for (const id of runIds) await deleteTestRunIfPresent(id);
  await rm(root, { recursive: true, force: true });
});
const lines = (label: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${label}-${index}\n`).join('');

/** A run's checkout at +270 -3, then the review fix that takes it to +312 -3 (run 4c0038bd). */
async function checkoutWithReviewFix() {
  const caseRoot = await mkdtemp(path.join(root, 'case-'));
  repo = path.join(caseRoot, 'repo');
  const origin = path.join(caseRoot, 'origin.git');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('init', '--bare', '-q', origin);
  git('remote', 'add', 'origin', origin);
  await writeFile(path.join(repo, 'src/first.ts'), lines('seed', 3));
  git('add', '.');
  git('commit', '-qm', 'test: seed');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'fix/headline');
  await writeFile(path.join(repo, 'src/first.ts'), lines('first', 200));
  await writeFile(path.join(repo, 'src/second.ts'), lines('second', 70));
  git('add', '.');
  git('commit', '-qm', 'test: reviewed head');
  const taskDir = path.join(caseRoot, 'task');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# Headline task\n');
  await writeFile(path.join(taskDir, 'artifacts/pr-description.md'), 'Fix\n');
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'example-headline',
    ticketOrPr: 'HEADLINE-1',
    runner: 'claude',
  });
  runIds.push(run.id);
  slotOwner = run.id;
  updateRun(run.id, {
    slotId: 'headline',
    branch: 'fix/headline',
    taskFile: path.join(taskDir, 'TASK.md'),
    engineState: {
      publishGate: { reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' } },
    },
  });
  // The gate on this head leaves its capture in artifacts/diff-stat.json.
  assert.deepEqual(await getDiffStat(getRun(run.id)!, { fresh: true }), {
    files: 2,
    additions: 270,
    deletions: 3,
  });
  await writeFile(path.join(repo, 'src/second.ts'), lines('second', 112));
  git('add', '.');
  git('commit', '-qm', 'test: review fix');
  slotCommands.length = 0;
  return { runId: run.id, headSha: git('rev-parse', 'HEAD'), git, taskDir };
}

async function presentGate(runId: string) {
  let card = '';
  let payload: ReadyGatePayload | undefined;
  await executeReadyGate(runId, {
    workerIdleWait: { pollMs: 1, maxPollMs: 1, timeoutMs: 1 },
    createDecision: async (_runId, _type, description, _actions, gatePayload) => {
      card = description;
      if (gatePayload?.kind === 'ready') payload = gatePayload;
      return 'abort';
    },
  });
  return { headline: card.split('\n').find((line) => line.startsWith('**Files:**')), payload };
}

// The lazy completion and gate imports load here, outside the timed cases.
const warm = await checkoutWithReviewFix();
await prepareCompletionPackage(warm.runId, { requireArtifactMirror: true });
await presentGate(warm.runId);

const stepContext: StepContext = {
  activeMonitors: new Map(),
  blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
  broadcastFn: () => {},
  createEngineDecision: async () => 'unused',
  executeNoChangeGate: async () => {},
  executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
  executeReadyGate: async () => 'ready',
  executeReviewGate: async () => {},
  getDiffStat,
  interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
  isHumanGateEnabled: async () => true,
  monitorTerminalError: ({ reason }) => new Error(reason),
  refreshRunLinks: async () => {},
  stepPartialIO: new Map(),
  deferTerminalSlotRelease: () => {},
};
const row: ReviewSelection = { runner: 'claude', model: null, effort: null, mode: 'cold' };

const preparers: Record<string, (runId: string) => Promise<unknown>> = {
  'a review of the fix': (runId) =>
    reconcilePublishGateReviewPlanResult(runId, [row], { reviewIds: ['fix-review'] }, stepContext),
  'a review recovered at gate entry': (runId) => executeHumanGateStep(runId, stepContext),
  'the complete step': (runId) => executeCompleteStep(runId, stepContext),
};

// Only a capture that recomputes the diff resolves its base this way; a durable read runs nothing.
const captureCount = () =>
  slotCommands.filter((command) => command === "git rev-parse --verify 'origin/main^{commit}'")
    .length;

for (const [preparer, prepare] of Object.entries(preparers)) {
  test(`the gate states the diff at its HEAD when ${preparer} prepared the package`, async () => {
    const { runId, headSha } = await checkoutWithReviewFix();
    await prepare(runId);
    const prepared = await readReadyGatePreparedPackage(getRun(runId)!);
    assert.equal(prepared?.headSha, headSha);
    assert.deepEqual(prepared?.reviewSnapshot?.diffStat, {
      files: 2,
      additions: 312,
      deletions: 3,
    });
    const { headline, payload } = await presentGate(runId);
    assert.equal(headline, '**Files:** 2 (+312 -3)');
    assert.deepEqual(payload?.diffStat, { files: 2, additions: 312, deletions: 3 });
    assert.equal(captureCount(), 1, 'the package and the gate share one capture');
    assert.equal(githubRequests, 0);
  });
}

test('a failed fetch states the diff at HEAD against the local base ref', async () => {
  const { runId, git, taskDir } = await checkoutWithReviewFix();
  git('remote', 'set-url', 'origin', path.join(root, 'no-such-origin.git'));
  await preparers['a review of the fix']!(runId);
  const { headline, payload } = await presentGate(runId);
  assert.equal(headline, '**Files:** 2 (+312 -3)');
  assert.deepEqual(payload?.diffStat, { files: 2, additions: 312, deletions: 3 });
  const durable = JSON.parse(
    await readFile(path.join(taskDir, 'artifacts/diff-stat.json'), 'utf8'),
  );
  assert.equal(durable.source, 'artifact');
  assert.equal(durable.available, true);
  assert.equal(durable.baseSha, git('rev-parse', 'origin/main'));
});

test('a failed fetch without a local base ref states no diff and the gate still presents', async () => {
  const { runId, git, taskDir } = await checkoutWithReviewFix();
  git('remote', 'set-url', 'origin', path.join(root, 'no-such-origin.git'));
  git('update-ref', '-d', 'refs/remotes/origin/main');
  await preparers['a review of the fix']!(runId);
  const { headline, payload } = await presentGate(runId);
  assert.equal(headline, '**Files:** 0 (+0 -0)');
  assert.deepEqual(payload?.diffStat, { files: 0, additions: 0, deletions: 0 });
  const durable = JSON.parse(
    await readFile(path.join(taskDir, 'artifacts/diff-stat.json'), 'utf8'),
  );
  assert.equal(durable.source, 'unavailable');
  assert.equal(durable.missingReason, 'base-ref-unavailable');
  assert.equal(captureCount(), 1, 'the gate does not retry an unavailable capture');
});
