import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { type AgentContext, FLOW_STEPS, type Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type { RunRecoveryCollaborators } from '../run-engine/recovery.js';
import { makeVars } from '../runners/test-fixtures.js';

// TAT-4033 6148c5e5: the worker's report opened an output review at 16:57Z, then the review
// sent 2 findings back. The 17:26Z reload landed mid-fix and recovery only re-presented the
// output review, so the 17:31Z REVIEW-FIX-SIGNAL of the live attempt was never consumed.
const vars = makeVars({ slotId: 'restart-fix-signal', projectName: 'restart-fix-signal' });
const CURRENT_ATTEMPT = 'b9fd7464-cd6e-4058-abfd-12a558c6a7ae';
const finishedCurrentAttempt = {
  attemptId: CURRENT_ATTEMPT,
  status: 'complete',
  outcome: 'success',
  disposition: 'fixed',
  timestamp: '2026-11-01T17:31:26.927Z',
};
// REVIEW-FIX-SIGNAL.json is reused by every fix pass in the task dir: an earlier pass's
// finished signal is still on disk when the live attempt starts.
const finishedEarlierAttempt = {
  attemptId: '7f3c2a10-earlier-fix-attempt',
  status: 'complete',
  outcome: 'success',
  timestamp: '2026-11-01T16:59:02.000Z',
};
// The live attempt mid-fix: its worker ran `mark start`, so the watcher bound its id.
const runningCurrentAttempt = {
  attemptId: CURRENT_ATTEMPT,
  status: 'running',
  timestamp: '2026-11-01T17:01:20.703Z',
};
let fixSignal: Record<string, string> = finishedCurrentAttempt;
let enteredWait = () => {};
const reReviewLoops: number[] = [];
let paneCommand = 'scripted-runner';
let tmuxTimeouts: RegExp | undefined;
let reviewDiffStat: string | undefined;
let fixDelta:
  | Awaited<ReturnType<typeof import('./snapshots.js').captureFixDeltaSnapshot>>
  | undefined;
let signalRemovals = 0;
const tmuxInput: string[] = [];
let onRespawn = (_command: string) => {};
let checklistRestores = 0;

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({ projectJson: { review: { enabled: true, max_retries: 2 } } }),
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (_vars: unknown, command: string) => {
      if (/send-keys|paste-buffer|respawn-window/u.test(command)) tmuxInput.push(command);
      if (command.includes('respawn-window')) onRespawn(command);
      if (/^rm -f .*REVIEW-FIX-SIGNAL/u.test(command)) {
        signalRemovals += 1;
        fixSignal = {};
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      if (command.includes('review-diff-stat.json'))
        return { exitCode: reviewDiffStat ? 0 : 1, stderr: '', stdout: reviewDiffStat ?? '' };
      // The launch acknowledgement's read leads with the file's mtime.
      if (command.includes('REVIEW-FIX-SIGNAL.json'))
        return {
          exitCode: 0,
          stderr: '',
          stdout: `${command.includes('stat -') ? '1\n' : ''}${JSON.stringify(fixSignal)}`,
        };
      if (command.includes('REVIEW-FIX.md'))
        return {
          exitCode: 0,
          stderr: '',
          stdout: '## Findings\n\n- **a.ts:1** — fix the finding\n- **b.ts:2** — fix the other\n',
        };
      if (tmuxTimeouts?.test(command)) return { exitCode: 124, stderr: '', stdout: '' };
      if (command.includes('tmux')) return { exitCode: 0, stderr: '', stdout: `${paneCommand}\n` };
      throw new Error(`Unexpected recovery fixture command: ${command}`);
    },
  },
});
const templates = await import('./templates.js');
mock.module('./templates.js', {
  namedExports: {
    ...templates,
    getReviewConfig: async () => ({ enabled: true, max_retries: 2 }),
    resolveWorkerTaskDir: async () => 'tasks/review',
  },
});
const capabilities = await import('../run-engine/declared-capabilities.js');
mock.module('../run-engine/declared-capabilities.js', {
  namedExports: { ...capabilities, prepareRetainedRunCapabilities: async () => {} },
});
const checklist = await import('../tasks/checklist-target.js');
mock.module('../tasks/checklist-target.js', {
  namedExports: {
    ...checklist,
    syncChecklistTargetForRole: async () => {},
    restoreWorkerChecklistTargetFromSlot: async () => {
      checklistRestores += 1;
    },
  },
});
const native = await import('./native-fix.js');
const tokenlessDelivery: typeof native.deliverNativeFix = async () => ({ status: 'deferred' });
mock.module('./native-fix.js', {
  namedExports: {
    ...native,
    deliverNativeFix: tokenlessDelivery,
    nativeFixTurnIsActive: async (_runId: string, command: string) => command === 'owned-command',
  },
});
const progress = await import('./progress.js');
mock.module('./progress.js', {
  namedExports: {
    ...progress,
    startProgressWatcher: () => {
      enteredWait();
      return { stop: async () => {}, ready: Promise.resolve() };
    },
  },
});
const REVIEWED_SNAPSHOT = {
  source: 'local-git',
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  headRef: 'feat/x',
  headSha: 'c'.repeat(40),
  diffHash: 'd'.repeat(64),
  diffStat: { files: 2, additions: 12, deletions: 0 },
  capturedAt: '2026-11-01T16:58:00.000Z',
  diffPath: 'artifacts/pipeline-review-loop-1/review.diff',
} as const;
const REVIEWED_SNAPSHOT_AFTER_FIX = { ...REVIEWED_SNAPSHOT, headSha: 'e'.repeat(40) };
const snapshots = await import('./snapshots.js');
mock.module('./snapshots.js', {
  namedExports: {
    ...snapshots,
    // No local-git delta: the gateway cannot accept the fix itself, so it must re-review.
    captureFixDeltaSnapshot: async () =>
      fixDelta ?? {
        snapshot: snapshots.unavailableReviewSnapshot('fixture has no checkout'),
        artifactPaths: [],
      },
    captureCurrentReviewSnapshot: async () => ({
      snapshot: REVIEWED_SNAPSHOT_AFTER_FIX,
      artifactPaths: [],
    }),
  },
});
const reviewer = await import('./native-review-agent.js');
mock.module('./native-review-agent.js', {
  namedExports: {
    ...reviewer,
    runNativeReviewAgent: async (input: { loopNumber: number }) => {
      reReviewLoops.push(input.loopNumber);
      return { verdict: 'pass' as const, issues: [] };
    },
  },
});
const watcher = await import('../tasks/watcher.js');
mock.module('../tasks/watcher.js', {
  namedExports: { ...watcher, watchContext: async () => {} },
});
const preflight = await import('../run-engine/worker-launch-preflight.js');
mock.module('../run-engine/worker-launch-preflight.js', {
  namedExports: { ...preflight, admitWorkerLaunch: async () => async () => {} },
});
const nodeSupport = await import('../node-support/ensure.js');
mock.module('../node-support/ensure.js', {
  namedExports: { ...nodeSupport, ensureNodeSupportBundle: async () => null },
});
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const { recoverActiveRuns } = await import('../run-engine/recovery.js');
// The native and capability readers can preload the facade before their mocks exist.
const recoveryModule = './orchestrator.js?restart-fix-signal';
const {
  executeReview,
  relaunchWorkerForFix,
  resumeReviewFixPromptDelivery,
  ReviewFixDeliveryError,
}: typeof import('./orchestrator.js') = await import(recoveryModule);

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The F299 run at the reload: REVIEW running its fix round, the output review still open. */
async function reviewFixRunAtReload(
  t: TestContext,
  transport: 'tmux' | 'native',
  runner: 'claude' | 'pi' | 'scripted' = 'claude',
): Promise<Run> {
  fixSignal = finishedCurrentAttempt;
  reReviewLoops.length = 0;
  tmuxInput.length = 0;
  tmuxTimeouts = undefined;
  reviewDiffStat = undefined;
  fixDelta = undefined;
  signalRemovals = 0;
  checklistRestores = 0;
  const priorOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'restart-fixture-owner';
  const run = createRun(
    {
      flowType: 'dev',
      mode: 'validation',
      project: vars.projectName,
      ticketOrPr: 'TAT-4033',
      runner,
      ...(runner === 'scripted'
        ? { scripted: { mode: 'scenario' as const, scenario: 'success' as const } }
        : {}),
      slotId: vars.slotId,
      transport,
    },
    { nativeOwnerPrincipalId: 'restart-fixture-owner' },
  );
  const slotRow = (remove = false) =>
    rewriteStatusFile((state) => ({
      ...state,
      slots: [
        ...(state?.slots ?? []).filter((slot) => slot.slot !== vars.slotId),
        ...(remove ? [] : [{ slot: vars.slotId, current_run_id: run.id }]),
      ],
    }));
  await slotRow();
  t.after(async () => {
    t.mock.timers.reset();
    if (priorOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = priorOwner;
    await slotRow(true);
    await deleteTestRunIfPresent(run.id);
  });
  const reviewAt = FLOW_STEPS.dev.indexOf('review');
  updateRun(run.id, {
    status: 'reconciling',
    taskFile: '/fixture/tasks/review/TASK.md',
    steps: FLOW_STEPS.dev.map((name, index) =>
      index < reviewAt
        ? { name, status: 'done' }
        : index === reviewAt
          ? { name, status: 'running', detail: 'Fix: 2/6 steps' }
          : { name, status: 'pending' },
    ),
    decisions: [
      {
        id: 'output-review',
        type: 'engine_output_review',
        title: 'Review run output',
        description: 'The worker has produced a report.',
        actions: [
          { id: 'close-run', label: 'Close run', style: 'primary' },
          { id: 'mark-reviewed', label: 'Mark reviewed', style: 'secondary' },
        ],
        createdAt: '2026-11-01T16:57:41.383Z',
        payload: {
          kind: 'output-review',
          manifestDigest: 'c48b8d31b9e0400d7557081d8579add00baee95bd40b49edd88dfb4d2aaa8f41',
          reportPath: 'artifacts/pr-description.md',
        },
      },
    ],
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        status: 'working',
        runId: run.id,
        slotId: vars.slotId,
        runner,
        model: run.metrics.model,
        target: {
          session: vars.slotId,
          window: 'dev',
          pane: null,
          target: `${vars.slotId}:dev`,
        },
        ...(transport === 'native' ? { nativeCommandId: 'owned-command' } : {}),
        taskFile: 'tasks/review/REVIEW-FIX.md',
        signalFile: 'tasks/review/REVIEW-FIX-SIGNAL.json',
        signalAttemptId: CURRENT_ATTEMPT,
        attemptStartedAt: '2026-11-01T17:01:20.703Z',
        promptDeliveryStartedAt: '2026-11-01T17:01:11.352Z',
        artifactScope: null,
      },
    ],
  });
  return getRun(run.id)!;
}

/**
 * Startup recovery as the gateway wires it, with the engine's REVIEW re-entry standing in
 * for `startRun`. Every collaborator a resumed fix wait must not reach fails the test.
 */
function restartRecovery(run: Run, reEnterReview: (runId: string) => void) {
  const refuse = (name: string) => (): never => assert.fail(`restart recovery called ${name}`);
  const deps: RunRecoveryCollaborators = {
    listRuns: () => ({ runs: [getRun(run.id)!] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: vars.slotId, lifecycle: 'busy', agent: 'working' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: refuse('readSlotField'),
    getRun,
    updateRun: (runId, fields) => {
      updateRun(runId, fields);
    },
    startRun: async (runId) => reEnterReview(runId),
    stopRunOwnedWorkers: refuse('stopRunOwnedWorkers'),
    updateRunStep: refuse('updateRunStep'),
    broadcast: refuse('broadcast'),
    reconcileRunAgentRuntime: refuse('reconcileRunAgentRuntime'),
    copyWorkerArtifacts: refuse('copyWorkerArtifacts'),
    readReviewArtifacts: refuse('readReviewArtifacts'),
    loadProjectVarsOrNull: refuse('loadProjectVarsOrNull'),
    retainedRunArtifactManifest: refuse('retainedRunArtifactManifest'),
    readTaskArtifactText: refuse('readTaskArtifactText'),
    setPrHealthOverlay: refuse('setPrHealthOverlay'),
    buildCIWatchChainedRunParams: refuse('buildCIWatchChainedRunParams'),
    createRun: refuse('createRun'),
    applyChainedRunEngineFlags: refuse('applyChainedRunEngineFlags'),
    reconstructStepOutputs: refuse('reconstructStepOutputs'),
    loadSlotVars: refuse('loadSlotVars'),
    getProjectFieldRaw: refuse('getProjectFieldRaw'),
    expandTemplate: refuse('expandTemplate'),
    clearStalePrepareProcess: refuse('clearStalePrepareProcess'),
    expandHook: refuse('expandHook'),
    execOnSlot: refuse('execOnSlot'),
    getProjectField: refuse('getProjectField'),
    setRunFlags: refuse('setRunFlags'),
    resetSlot: refuse('resetSlot'),
    retryOccupiedRunSlot: refuse('retryOccupiedRunSlot'),
    resumeInterruptedRecovery: refuse('resumeInterruptedRecovery'),
    resetSlotIf: refuse('resetSlotIf'),
    updateSlotStatusIf: refuse('updateSlotStatusIf'),
    quarantineLeakedRun: refuse('quarantineLeakedRun'),
    rearmHandoffAutoRecovery: refuse('rearmHandoffAutoRecovery'),
    rearmPublicationReviewRecovery: refuse('rearmPublicationReviewRecovery'),
    recoverInflightPublicationReviews: refuse('recoverInflightPublicationReviews'),
    replayHumanGate: refuse('replayHumanGate'),
    resumeHeldPublicationGate: refuse('resumeHeldPublicationGate'),
  };
  return recoverActiveRuns(deps);
}

function fixContext(runId: string) {
  return getRun(runId)?.agentContexts?.find((context) => context.id === 'review-fix');
}

test('restart adopts the finished fix of the live attempt past an open output review, then re-reviews', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux');
  let reviewing: ReturnType<typeof executeReview> | undefined;

  await restartRecovery(run, (runId) => {
    reviewing = executeReview(runId, vars.slotId, { validationDepth: 'static-code' });
  });

  assert.ok(reviewing, 'recovery re-entered the review step instead of re-presenting');
  const result = await reviewing;
  assert.deepEqual(reReviewLoops, [2], 'the adopted fix goes to its re-review');
  assert.equal(result.verdict, 'pass');
  assert.equal(fixContext(run.id)?.status, 'complete');
  assert.equal(fixContext(run.id)?.signalAttemptId, CURRENT_ATTEMPT);
  assert.equal(
    getRun(run.id)?.decisions.find((decision) => decision.id === 'output-review')?.resolvedAt,
    undefined,
    'the output review stays open for the operator',
  );
});

test('restart resumes the live fix wait and never adopts a signal from an earlier attempt', async (t) => {
  const run = await reviewFixRunAtReload(t, 'native');
  fixSignal = finishedEarlierAttempt;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T17:26:42Z') });
  const waiting = new Promise<void>((resolve) => {
    enteredWait = resolve;
  });
  let reviewing: ReturnType<typeof executeReview> | undefined;

  await restartRecovery(run, (runId) => {
    reviewing = executeReview(runId, vars.slotId, { validationDepth: 'static-code' });
  });

  assert.ok(reviewing, 'recovery re-entered the review step instead of re-presenting');
  await Promise.race([
    waiting,
    reviewing.then(() => {
      throw new Error('Recovery returned before entering its fix wait');
    }),
  ]);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(reReviewLoops, [], 'a signal from an earlier attempt is not this fix');
  assert.equal(fixContext(run.id)?.status, 'working');
  assert.equal(fixContext(run.id)?.signalAttemptId, CURRENT_ATTEMPT);
  assert.equal(getRun(run.id)?.status, 'fixing');

  // The worker finishes the live attempt while recovery waits.
  fixSignal = finishedCurrentAttempt;
  t.mock.timers.tick(2000);
  await flush();
  const result = await reviewing;
  assert.deepEqual(reReviewLoops, [2]);
  assert.equal(result.verdict, 'pass');
  assert.equal(fixContext(run.id)?.status, 'complete');
  assert.equal(fixContext(run.id)?.signalAttemptId, CURRENT_ATTEMPT);
});

/** Runs real I/O under mocked timers until `done`; a stuck recovery fails instead of timing out. */
async function until(done: () => boolean, tickMs = 0, t?: TestContext) {
  const deadline = performance.now() + 2000;
  while (!done() && performance.now() < deadline) {
    if (tickMs) t?.mock.timers.tick(tickMs);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Settles a recovered review step under mocked timers, to its result or its error. */
async function settled(t: TestContext, reviewing: ReturnType<typeof executeReview>) {
  let done = false;
  const outcome = reviewing.then(
    (result) => {
      done = true;
      return result;
    },
    (error: unknown) => {
      done = true;
      return error;
    },
  );
  await until(() => done, 5000, t);
  assert.equal(done, true, 'recovery neither returned nor failed');
  return outcome;
}

const WORKER_PANE = { scripted: 'scripted-runner', claude: 'claude' } as const;

for (const runner of ['scripted', 'claude'] as const)
  test(`restart leaves a ${runner} worker mid-fix waiting for its signal, then re-reviews`, async (t) => {
    const run = await reviewFixRunAtReload(t, 'tmux', runner);
    fixSignal = runningCurrentAttempt;
    paneCommand = WORKER_PANE[runner];
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T17:26:42Z') });
    let waiting = false;
    enteredWait = () => {
      waiting = true;
    };
    let reviewing: ReturnType<typeof executeReview> | undefined;

    await restartRecovery(run, (runId) => {
      reviewing = executeReview(runId, vars.slotId, { validationDepth: 'static-code' });
    });
    assert.ok(reviewing, 'recovery re-entered the review step');
    let returned = false;
    void reviewing.finally(() => {
      returned = true;
    });
    await until(() => waiting || returned);
    assert.equal(returned, false, 'recovery returned instead of waiting for the fix signal');
    assert.equal(waiting, true);
    assert.deepEqual(tmuxInput, [], 'the worker holds its prompt: nothing is sent or relaunched');
    assert.equal(fixContext(run.id)?.status, 'working');

    // The worker finishes while recovery waits.
    fixSignal = finishedCurrentAttempt;
    await until(() => returned, 2000, t);
    const result = await reviewing;
    assert.deepEqual(reReviewLoops, [2]);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.fixDeliveryFailure, undefined);
    assert.equal(fixContext(run.id)?.status, 'complete');
  });

for (const runner of ['scripted', 'claude'] as const)
  test(`a recorded ${runner} send nothing confirms fails REVIEW for the card, with the worker and its checklist kept`, async (t) => {
    const run = await reviewFixRunAtReload(t, 'tmux', runner);
    // The earlier round's signal, and an id the watcher bound from it: neither is this send's.
    fixSignal = { status: 'running', attemptId: 'earlier', timestamp: '2026-11-01T17:01:00.000Z' };
    paneCommand = WORKER_PANE[runner];
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T17:26:42Z') });
    let reviewing: ReturnType<typeof executeReview> | undefined;

    await restartRecovery(run, (runId) => {
      reviewing = executeReview(runId, vars.slotId, { validationDepth: 'static-code' });
    });
    assert.ok(reviewing, 'recovery re-entered the review step');
    const failure = await settled(t, reviewing);
    // `reconciling` has no client exit: only this error reaches the engine's card.
    assert.ok(
      failure instanceof ReviewFixDeliveryError,
      `expected a step error, got ${JSON.stringify(failure)}`,
    );
    assert.deepEqual(tmuxInput, [], 'nothing is sent while delivery is uncertain');
    assert.equal(fixContext(run.id)?.status, 'working');
    assert.equal(checklistRestores, 0, 'the worker may be executing: its mark helper stays put');
  });

for (const [read, timedOut] of [
  ['session', /has-session|new-session/u],
  ['pane command', /display-message/u],
] as const)
  test(`a timed-out ${read} read is not a gone worker: nothing is sent or relaunched`, async (t) => {
    const run = await reviewFixRunAtReload(t, 'tmux', 'claude');
    fixSignal = { status: 'running', attemptId: 'earlier', timestamp: '2026-11-01T17:01:00.000Z' };
    tmuxTimeouts = timedOut;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T17:26:42Z') });
    let reviewing: ReturnType<typeof executeReview> | undefined;

    await restartRecovery(run, (runId) => {
      reviewing = executeReview(runId, vars.slotId, { validationDepth: 'static-code' });
    });
    assert.ok(reviewing, 'recovery re-entered the review step');
    assert.ok((await settled(t, reviewing)) instanceof Error);
    assert.deepEqual(tmuxInput, []);
    assert.equal(fixContext(run.id)?.status, 'working');
    assert.equal(checklistRestores, 0, 'the worker may be executing: its mark helper stays put');
  });

test('recovery does not wait for a fix round it re-entered, so other runs recover meanwhile', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux', 'scripted');
  let recovered = false;
  void restartRecovery(run, () => new Promise(() => {})).then(() => {
    recovered = true;
  });
  await until(() => recovered);
  assert.equal(recovered, true, 'the recovery loop awaited the re-entered step');
});

/** The fix context plus the primary worker a relaunch replaces. */
function withPrimaryWorker(runId: string, fix: Partial<AgentContext> = {}) {
  const [context] = getRun(runId)!.agentContexts!;
  updateRun(runId, {
    agentContexts: [
      { ...context!, id: 'dev', role: 'dev' },
      { ...context!, ...fix },
    ],
  });
}

test('a small fix recovered after a restart is accepted from the persisted snapshot, with no new reviewer', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux', 'scripted');
  reviewDiffStat = JSON.stringify(REVIEWED_SNAPSHOT);
  fixDelta = {
    snapshot: {
      source: 'local-git',
      baseSha: REVIEWED_SNAPSHOT.baseSha,
      headSha: REVIEWED_SNAPSHOT_AFTER_FIX.headSha,
      fixBaseSha: REVIEWED_SNAPSHOT.headSha,
      fixHeadSha: REVIEWED_SNAPSHOT_AFTER_FIX.headSha,
      diffPath: 'artifacts/pipeline-review-loop-2/fix-delta.diff',
      diffHash: 'f'.repeat(64),
      diffStat: { files: 1, additions: 0, deletions: 6 },
      capturedAt: '2026-11-01T17:31:27.000Z',
    },
    artifactPaths: [],
    sourceLinesChanged: 6,
  };
  let reviewing: ReturnType<typeof executeReview> | undefined;

  await restartRecovery(run, (runId) => {
    reviewing = executeReview(runId, vars.slotId, { validationDepth: 'static-code' });
  });
  assert.ok(reviewing, 'recovery re-entered the review step');
  const result = await reviewing;
  assert.deepEqual(reReviewLoops, [], 'the gateway accepts a small fix without another reviewer');
  assert.equal(result.verdict, 'pass');
});

for (const runner of ['scripted', 'pi'] as const)
  test(`the operator's Replay that again finds no proof relaunches a ${runner} worker once`, async (t) => {
    const run = await reviewFixRunAtReload(t, 'tmux', runner);
    withPrimaryWorker(run.id);
    fixSignal = { status: 'running', attemptId: 'earlier', timestamp: '2026-11-01T17:01:00.000Z' };
    paneCommand = runner === 'pi' ? 'pi-coding-agent' : 'scripted-runner';
    const sentAt = fixContext(run.id)?.promptDeliveryStartedAt;
    updateRun(run.id, {
      recoveryAttempts: [
        {
          id: 'card-replay',
          attempt: 1,
          stepName: 'review',
          startedAt: '2026-11-01T17:26:00.000Z',
          status: 'started',
          triggeredBy: 'operator',
        },
      ],
    });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T17:26:42Z') });

    const failure = await settled(
      t,
      executeReview(run.id, vars.slotId, { validationDepth: 'static-code' }),
    );
    assert.equal(
      tmuxInput.filter((command) => command.includes('respawn-window')).length,
      1,
      'one relaunch: it hands over the prompt, so nothing replaces it again',
    );
    assert.notEqual(fixContext(run.id)?.promptDeliveryStartedAt, sentAt, 'a new send is recorded');
    assert.ok(
      failure instanceof ReviewFixDeliveryError,
      `the new send has no proof yet, and no Replay answered it: ${JSON.stringify(failure)}`,
    );
  });

test('a relaunch clears the earlier worker signal, so a leading worker clock cannot confirm its send', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux', 'pi');
  paneCommand = 'pi-coding-agent';
  withPrimaryWorker(run.id);
  // Written before this relaunch, on a clock far ahead of the gateway's.
  fixSignal = { status: 'running', attemptId: 'earlier', timestamp: '2099-01-01T00:00:00.000Z' };
  let removalsAtRespawn = 0;
  onRespawn = () => {
    removalsAtRespawn = signalRemovals;
  };
  t.after(() => {
    onRespawn = () => {};
  });

  assert.equal(await relaunchWorkerForFix(vars, 'pi', 'local/model', run.id), true);
  assert.equal(removalsAtRespawn, 1, 'gone before the new worker can write its own');
  const delivery = await resumeReviewFixPromptDelivery(vars, run.id, fixContext(run.id)!);
  assert.equal(delivery.status, 'deferred', 'nothing shows this worker holds its prompt');
});

test('a relaunch before a new round keeps the finished round signal the next send reads', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux', 'pi');
  paneCommand = 'pi-coding-agent';
  withPrimaryWorker(run.id, { status: 'complete', promptDeliveryStartedAt: undefined });

  assert.equal(await relaunchWorkerForFix(vars, 'pi', 'local/model', run.id), true);
  assert.equal(signalRemovals, 0);
  assert.equal(
    fixContext(run.id)?.promptDeliveryStartedAt,
    undefined,
    'it sends this round nothing',
  );
});

test('a launch that carries the prompt records its delivery before the respawn', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux', 'pi');
  paneCommand = 'pi-coding-agent';
  const earlier = fixContext(run.id)?.promptDeliveryStartedAt;
  withPrimaryWorker(run.id);
  let recorded: string | undefined;
  onRespawn = () => {
    recorded = fixContext(run.id)?.promptDeliveryStartedAt;
  };
  t.after(() => {
    onRespawn = () => {};
  });

  assert.equal(await relaunchWorkerForFix(vars, 'pi', 'local/model', run.id), true);
  assert.ok(recorded, 'the delivery boundary was written before the worker could hold the prompt');
  assert.notEqual(recorded, earlier, 'an earlier worker signal must not confirm this send');
});

test('a post-launch relaunch clears the boundary once the new process replaced the old', async (t) => {
  const run = await reviewFixRunAtReload(t, 'tmux', 'claude');
  paneCommand = 'claude';
  withPrimaryWorker(run.id);
  let recorded: string | undefined = 'unset';
  let launch = '';
  onRespawn = (command) => {
    recorded = fixContext(run.id)?.promptDeliveryStartedAt;
    launch = command;
  };
  t.after(() => {
    onRespawn = () => {};
  });

  assert.equal(await relaunchWorkerForFix(vars, 'claude', 'sonnet', run.id), true);
  assert.equal(recorded, '2026-11-01T17:01:11.352Z', 'until then the old worker may hold it');
  assert.equal(
    fixContext(run.id)?.promptDeliveryStartedAt,
    undefined,
    'restart recovery must send this prompt, not wait for it',
  );
  assert.doesNotMatch(launch, /Farmslot fix delivery/u);
});
