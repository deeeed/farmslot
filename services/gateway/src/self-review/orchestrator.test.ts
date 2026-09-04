import assert from 'node:assert/strict';
import test from 'node:test';

import type { SelfReviewIssue, WorkerSignal } from '@farmslot/protocol';

import { parseSelfReviewIssueBullets } from './issues.js';
import {
  canRecoverSelfReviewFixPass,
  resolveRecoveredFixBaseSha,
  resolveSelfReviewRunnerModel,
  resumeSelfReviewFixPromptDelivery,
  retryDeferredFixDelivery,
  runSelfReviewRetryLoop,
  SelfReviewFixDeliveryError,
  type SelfReviewRetryDeps,
  shouldSkipForDisabledSelfReviewConfig,
} from './orchestrator.js';
import type { ReviewAgentResult } from './review-agent.js';

test('parseSelfReviewIssueBullets recovers issues from SELF-REVIEW-FIX.md', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues Found by Self-Review

- **modal-footer.test.tsx:9** — remove should from test name.
- **src/no-line.ts** — explain issue without a line.
`);

  assert.deepEqual(issues, [
    { file: 'modal-footer.test.tsx', line: 9, description: 'remove should from test name.' },
    { file: 'src/no-line.ts', line: undefined, description: 'explain issue without a line.' },
  ]);
});

test('parseSelfReviewIssueBullets accepts review-feedback backtick locations', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
- \`ui/__mocks__/perps/perps-controller/index.ts:790\` — mock type lacks isHip3.
- \`lavamoat/build-system/policy.json:6908\` — unrelated OS-specific policy churn.
`);

  assert.deepEqual(issues, [
    {
      file: 'ui/__mocks__/perps/perps-controller/index.ts',
      line: 790,
      description: 'mock type lacks isHip3.',
    },
    {
      file: 'lavamoat/build-system/policy.json',
      line: 6908,
      description: 'unrelated OS-specific policy churn.',
    },
  ]);
});

test('parseSelfReviewIssueBullets ignores bullets outside the Issues section', () => {
  const issues = parseSelfReviewIssueBullets(`
# Self-Review: MANUAL-000014

## Verdict: ISSUES

## Validation
- \`yarn typecheck\` — pass.

## Evidence
- **before-flow-selector.png** — FLOW pills end in \`merge-main\`. ✔ baseline.
- **after-flow-selector.png** — same row now ends in \`update-branch\`; delta is real.

## Issues
- **src/real-problem.ts:12** — the only actual finding.
`);

  assert.deepEqual(issues, [
    { file: 'src/real-problem.ts', line: 12, description: 'the only actual finding.' },
  ]);
});

test('parseSelfReviewIssueBullets parses numbered title-style items', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues (cheap, introduced by this PR — non-blocking)

1. **Inaccurate JSDoc — wrong threading claim.**
   \`packages/protocol/src/contracts/runs.ts:1247\` says the field is threaded
   into prepare. It is not.

2. **\`resolveBranchUpdateStrategy\` has zero production callers.**
   Exported and unit-tested but never invoked.

## Recommended action

Publishable after fixing the above.
`);

  assert.equal(issues.length, 2);
  assert.equal(issues[0].file, 'packages/protocol/src/contracts/runs.ts');
  assert.equal(issues[0].line, 1247);
  assert.match(issues[0].description, /Inaccurate JSDoc/);
  assert.match(issues[1].description, /zero production callers/);
});

test('parseSelfReviewIssueBullets ignores fenced code blocks and placeholder bullets', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
- **src/a.ts:1** — wrong return type

\`\`\`diff
- removed line
+ added line
\`\`\`
- <empty for PASS>
- \`src/b.ts:2\` — second real finding
`);

  assert.deepEqual(issues, [
    { file: 'src/a.ts', line: 1, description: 'wrong return type' },
    { file: 'src/b.ts', line: 2, description: 'second real finding' },
  ]);
});

test('parseSelfReviewIssueBullets survives headings and fences inside the Issues section', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
- **src/a.ts:1** — first finding

\`\`\`markdown
## Example
- **fake.ts:9** — not a finding
\`\`\`

~~~
- also not a finding
~~~

- **src/b.ts:2** — finding after the fences

## Recommended action
- **not-an-issue.md** — different section
`);

  assert.deepEqual(issues, [
    { file: 'src/a.ts', line: 1, description: 'first finding' },
    { file: 'src/b.ts', line: 2, description: 'finding after the fences' },
  ]);
});

test('parseSelfReviewIssueBullets strips unterminated fences to end of input', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
- **src/a.ts:1** — real finding

\`\`\`diff
- **phantom.ts:5** — inside an unterminated fence
`);

  assert.deepEqual(issues, [{ file: 'src/a.ts', line: 1, description: 'real finding' }]);
});

test('parseSelfReviewIssueBullets accepts CommonMark 1-3 space indentation', () => {
  const issues = parseSelfReviewIssueBullets(
    '  ## Issues\n' + '   - **src/indented.ts:7** — heading and bullet both indented\n',
  );

  assert.deepEqual(issues, [
    { file: 'src/indented.ts', line: 7, description: 'heading and bullet both indented' },
  ]);
});

test('parseSelfReviewIssueBullets prefers path-looking backtick tokens for title-style items', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
1. **\`resolveFoo\` is wrong.** See \`src/foo.ts:42\` for the call site.
`);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'src/foo.ts');
  assert.equal(issues[0].line, 42);
});

test('parseSelfReviewIssueBullets: inner fence-with-info lines do not close an open fence', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
- **src/a.ts:1** — real finding

\`\`\`markdown
\`\`\`diff
- **phantom.ts:5** — still inside the outer fence
\`\`\`

- **src/b.ts:2** — finding after the fence closes
`);

  assert.deepEqual(issues, [
    { file: 'src/a.ts', line: 1, description: 'real finding' },
    { file: 'src/b.ts', line: 2, description: 'finding after the fence closes' },
  ]);
});

test('parseSelfReviewIssueBullets folds nested sub-bullets but splits uniformly indented lists', () => {
  const nested = parseSelfReviewIssueBullets(`
## Issues
- **src/a.ts:1** — finding with evidence
  - nested evidence bullet
  - more evidence
- **src/b.ts:2** — second finding
`);
  assert.equal(nested.length, 2);
  assert.match(nested[0].description, /nested evidence bullet/);

  const uniform = parseSelfReviewIssueBullets(
    '## Issues\n' + '   - **src/a.ts:1** — first\n' + '   - **src/b.ts:2** — second\n',
  );
  assert.deepEqual(
    uniform.map((i) => i.file),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('parseSelfReviewIssueBullets ranks slash/:line tokens above extension-only tokens', () => {
  const issues = parseSelfReviewIssueBullets(`
## Issues
1. **The \`foo.bar\` config key is stale.** Real location is \`src/foo.ts:42\`.
`);

  assert.equal(issues[0].file, 'src/foo.ts');
  assert.equal(issues[0].line, 42);
});

test('parseSelfReviewIssueBullets falls back to whole document without an Issues heading', () => {
  const issues = parseSelfReviewIssueBullets(`
- **src/legacy.ts:3** — legacy artifact without sections.
`);

  assert.deepEqual(issues, [
    { file: 'src/legacy.ts', line: 3, description: 'legacy artifact without sections.' },
  ]);
});

test('canRecoverSelfReviewFixPass requires a working context for the current fix task', () => {
  const current = {
    role: 'self-review-fix',
    status: 'working',
    taskFile: 'tasks/foo/SELF-REVIEW-FIX.md',
    signalFile: 'tasks/foo/SELF-REVIEW-FIX-SIGNAL.json',
    artifactScope: 'independent-review-4',
  } as const;

  assert.equal(canRecoverSelfReviewFixPass(current, 'tasks/foo'), true);
  assert.equal(
    canRecoverSelfReviewFixPass(current, 'tasks/foo', 'independent-review-4'),
    true,
    'a fix context owned by the current findings generation is recoverable',
  );
  assert.equal(
    canRecoverSelfReviewFixPass(
      { ...current, artifactScope: null },
      'tasks/foo',
      'independent-review-4',
    ),
    true,
    'an in-flight context created before generation ownership can be bound during recovery',
  );
  assert.equal(
    canRecoverSelfReviewFixPass(current, 'tasks/foo', 'independent-review-5'),
    false,
    'a fix context owned by another findings generation must not be recovered',
  );
  assert.equal(canRecoverSelfReviewFixPass(null, 'tasks/foo'), false);
  assert.equal(
    canRecoverSelfReviewFixPass({ ...current, status: 'complete' }, 'tasks/foo'),
    false,
    'completed fix contexts must not resurrect a stale signal',
  );
  assert.equal(
    canRecoverSelfReviewFixPass(
      { ...current, taskFile: 'tasks/bar/SELF-REVIEW-FIX.md' },
      'tasks/foo',
    ),
    false,
    'a fix for another task dir is not valid recovery state',
  );
  assert.equal(
    canRecoverSelfReviewFixPass({ ...current, signalFile: null }, 'tasks/foo'),
    false,
    'legacy contexts without the scoped signal path are not valid recovery state',
  );
});

test('resolveRecoveredFixBaseSha prefers the persisted delivery baseline', () => {
  assert.equal(
    resolveRecoveredFixBaseSha(
      {
        engineState: {
          publishGate: {
            independentReviews: [
              {
                id: 'independent-review-4',
                reviewSnapshot: { source: 'local-git', capturedAt: '', headSha: 'review-head' },
              },
            ],
          },
        },
      } as never,
      { artifactScope: 'independent-review-4', deliveryBaselineRef: 'delivery-head' },
    ),
    'delivery-head',
  );
});

test('resolveRecoveredFixBaseSha reconstructs legacy contexts from their review generation', () => {
  assert.equal(
    resolveRecoveredFixBaseSha(
      {
        engineState: {
          publishGate: {
            independentReviews: [
              {
                id: 'independent-review-4',
                reviewSnapshot: { source: 'local-git', capturedAt: '', headSha: 'review-head' },
              },
            ],
          },
        },
      } as never,
      { artifactScope: 'independent-review-4' },
    ),
    'review-head',
  );
});

test('restart recovery re-delivers a Cursor worker fix instead of returning unsupported', async () => {
  let delivered = false;
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    effort: 'high',
    safetyTier: 'dangerous',
    metrics: { runner: 'cursor', model: 'cursor-grok-4.6-high-fast' },
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        runnerSessionId: null,
        runnerSessionPath: null,
      },
    ],
  };
  const result = await resumeSelfReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'self-review-fix',
      runner: 'cursor',
      model: 'cursor-grok-4.6-high-fast',
      taskFile: 'tasks/run-1/SELF-REVIEW-FIX.md',
      signalFile: 'tasks/run-1/SELF-REVIEW-FIX-SIGNAL.json',
      target: { session: 'mm-4', window: 'bugfix', target: 'mm-4:bugfix' },
      startedAt: '2026-08-24T02:25:44.906Z',
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      getRun: (() => run) as never,
      resolvePrompt: async (_project, input) => `read ${input.taskFile}`,
      resolveRuntimeDir: async () => '.sandbox/farmslot-farm/agent',
      readLaunchAck: async () => null,
      syncChecklistTarget: async () => {},
      ensureTarget: async () => 'mm-4:bugfix',
      persistTarget: async () => {},
      deliver: async (options) => {
        delivered = true;
        assert.equal(options.runnerId, 'cursor');
        assert.match(options.prompt, /SELF-REVIEW-FIX\.md/);
        return { delivered: true, acknowledgement: 'safe-send' };
      },
    },
  );

  assert.deepEqual(result, { status: 'delivered' });
  assert.equal(delivered, true);
});

test('restart recovery re-delivers the existing fix task without rewriting it', async () => {
  let delivered = false;
  let restored = false;
  let checklistTargetRestored = false;
  let persistedTarget: string | null = null;
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    effort: 'high',
    safetyTier: 'dangerous',
    metrics: { runner: 'claude', model: 'opus' },
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        runnerSessionId: 'session-1',
        runnerSessionPath: '/sessions/session-1.jsonl',
      },
    ],
  };
  const result = await resumeSelfReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'self-review-fix',
      runner: 'claude',
      model: 'opus',
      taskFile: 'tasks/run-1/SELF-REVIEW-FIX.md',
      signalFile: 'tasks/run-1/SELF-REVIEW-FIX-SIGNAL.json',
      target: { session: 'ff-1', window: 'bugfix', target: 'ff-1:bugfix' },
      startedAt: '2026-08-03T12:00:00.000Z',
      attemptStartedAt: '2026-08-04T08:15:00.000Z',
    },
    {
      getRun: (() => run) as never,
      resolvePrompt: async (_project, input) => `read ${input.taskFile}`,
      resolveRuntimeDir: async () => '.sandbox/farmslot-farm/agent',
      readLaunchAck: async (_vars, signalPath) => {
        assert.equal(signalPath, '/repo/tasks/run-1/SELF-REVIEW-FIX-SIGNAL.json');
        return null;
      },
      syncChecklistTarget: async (_vars, taskDir, role) => {
        assert.equal(taskDir, 'tasks/run-1');
        assert.equal(role, 'self-review-fix');
        checklistTargetRestored = true;
      },
      ensureTarget: async (_vars, session, target, window, flowType) => {
        restored = true;
        assert.equal(session, 'ff-1');
        assert.equal(target, 'ff-1:bugfix');
        assert.equal(window, 'bugfix');
        assert.equal(flowType, 'fix-bug');
        return 'ff-1:bugfix-restored';
      },
      persistTarget: async (_runId, _run, target) => {
        persistedTarget = target?.target ?? null;
        assert.deepEqual(target, {
          session: 'ff-1',
          window: 'bugfix-restored',
          pane: null,
          target: 'ff-1:bugfix-restored',
        });
      },
      deliver: async (options) => {
        delivered = true;
        assert.equal(options.target, 'ff-1:bugfix-restored');
        assert.match(options.prompt, /^read tasks\/run-1\/SELF-REVIEW-FIX\.md\n\n/);
        assert.match(
          options.prompt,
          /tasks\/run-1\/mark --checklist SELF-REVIEW-FIX\.md --signal SELF-REVIEW-FIX-SIGNAL\.json start/,
        );
        assert.match(options.prompt, /complete --mark-last/);
        assert.match(options.prompt, /no-change --reason/);
        assert.match(options.prompt, /blocked --reason/);
        assert.match(options.prompt, /Farmslot fix delivery attempt: 2026-08-04T08:15:00\.000Z$/);
        assert.equal(options.sessionId, 'session-1');
        assert.equal(options.sessionPath, '/sessions/session-1.jsonl');
        assert.equal(options.priorPromptSendAttempted, false);
        assert.equal(options.forceBusyPoll, true);
        return { delivered: true, acknowledgement: 'safe-send' };
      },
    },
  );

  assert.deepEqual(result, { status: 'delivered' });
  assert.equal(restored, true);
  assert.equal(checklistTargetRestored, true);
  assert.equal(persistedTarget, 'ff-1:bugfix-restored');
  assert.equal(delivered, true);
});

test('restart recovery preserves a persisted fix prompt delivery boundary', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'cursor', model: 'cursor-grok-4.6-high-fast' },
    agentContexts: [],
  };
  const result = await resumeSelfReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'self-review-fix',
      runner: 'cursor',
      model: 'cursor-grok-4.6-high-fast',
      taskFile: 'tasks/run-1/SELF-REVIEW-FIX.md',
      signalFile: 'tasks/run-1/SELF-REVIEW-FIX-SIGNAL.json',
      target: { session: 'mm-4', window: 'bugfix', target: 'mm-4:bugfix' },
      attemptStartedAt: '2026-08-04T08:15:00.000Z',
      promptDeliveryStartedAt: '2026-08-04T08:15:01.000Z',
    },
    {
      getRun: (() => run) as never,
      resolvePrompt: async () => 'read fix task',
      resolveRuntimeDir: async () => '.agent',
      readLaunchAck: async () => null,
      syncChecklistTarget: async () => {},
      ensureTarget: async () => 'mm-4:bugfix',
      persistTarget: async () => {},
      targetHostsRunner: async () => true,
      deliver: async (options) => {
        assert.equal(options.priorPromptSendAttempted, true);
        return {
          delivered: false,
          disposition: 'hold',
          reason: 'unacknowledged prior send',
          retryable: false,
        };
      },
    },
  );
  assert.deepEqual(result, { status: 'deferred' });
});

test('restart recovery requests a fresh worker after an unacknowledged retained handoff', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'claude', model: 'opus' },
    agentContexts: [],
  };
  const result = await resumeSelfReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'self-review-fix',
      runner: 'claude',
      model: 'opus',
      taskFile: 'tasks/run-1/SELF-REVIEW-FIX.md',
      signalFile: 'tasks/run-1/SELF-REVIEW-FIX-SIGNAL.json',
      target: { session: 'ff-1', window: 'bugfix', target: 'ff-1:bugfix' },
      attemptStartedAt: '2026-08-04T08:15:00.000Z',
    },
    {
      getRun: (() => run) as never,
      resolvePrompt: async () => 'read fix task',
      resolveRuntimeDir: async () => '.sandbox/farmslot-farm/agent',
      readLaunchAck: async () => null,
      syncChecklistTarget: async () => {},
      ensureTarget: async () => 'ff-1:bugfix',
      persistTarget: async () => {},
      deliver: async () => ({
        delivered: false,
        disposition: 'hold',
        reason: 'prompt was not acknowledged',
        retryable: false,
      }),
    },
  );

  assert.deepEqual(result, { status: 'relaunch-required' });
});

test('resolveSelfReviewRunnerModel keeps self-review on the worker runner by default', () => {
  assert.deepEqual(
    resolveSelfReviewRunnerModel('cursor', 'composer-2.5', { runner: 'same', model: 'opus' }, {}),
    { reviewRunner: 'cursor', model: 'composer-2.5', crossRunner: false },
  );
});

test('resolveSelfReviewRunnerModel uses project review model only for configured review runner', () => {
  assert.deepEqual(
    resolveSelfReviewRunnerModel('cursor', 'composer-2.5', { runner: 'claude', model: 'opus' }, {}),
    { reviewRunner: 'claude', model: 'opus', crossRunner: true },
  );
});

test('resolveSelfReviewRunnerModel ignores project self_review.model for plan-requested cross-runners', () => {
  assert.deepEqual(
    resolveSelfReviewRunnerModel(
      'claude',
      'opus',
      { runner: 'same', model: 'opus' },
      { reviewRunner: 'codex', model: null },
    ),
    { reviewRunner: 'codex', model: 'gpt-5.6-sol', crossRunner: true },
  );
});

test('disabled project self-review does not skip explicit publication reviews', () => {
  assert.equal(shouldSkipForDisabledSelfReviewConfig({ enabled: false }), true);
  assert.equal(
    shouldSkipForDisabledSelfReviewConfig({ enabled: false }, { publicationReview: true }),
    false,
  );
  assert.equal(shouldSkipForDisabledSelfReviewConfig({ enabled: true }), false);
});

// ─── runSelfReviewRetryLoop ───
//
// The loop's central invariant: it keeps `review → fix → re-review` going up to maxRetries
// times, then stops. Each fix pass must clear and re-baseline the signal so a long worker
// run on retry N+1 isn't capped by retry N's leftover timeout. Tests inject a deps mock
// to drive scripted scenarios.

const ISSUES: SelfReviewIssue[] = [{ file: 'a.ts', line: 1, description: 'x' }];

// Real SlotVars carries dozens of unrelated fields; the loop only reads remoteRepo.
const fakeVars = { remoteRepo: '/repo' } as any;

interface ScriptedDepsOptions {
  reviewVerdicts: Array<'pass' | 'issues' | 'incomplete'>;
  workerAlive?: boolean;
  relaunchOk?: boolean;
  fixSignals?: Array<WorkerSignal | undefined>; // undefined = timeout
  contextPct?: number | null; // omitted = dep not wired (legacy behavior)
  feedbackError?: string;
  feedbackErrors?: Array<Error | undefined>;
  fixDeltaFiles?: number;
  fixDeltaUnavailable?: boolean;
}

interface CallLog {
  sendFeedback: number;
  reviewAgent: number;
  relaunches: number;
  markStatus: string[];
  feedbackBaselines: string[]; // baseline returned to the loop on each sendFeedbackToWorker call
  fixBaseShas: Array<string | null>;
  waitBaselines: string[]; // baseline forwarded into waitForWorkerSignal on each iteration
  artifactScopes: Array<string | null | undefined>;
  sessionPolicies: Array<string | undefined>; // 11th runReviewAgent arg per re-review
  progressDetails: string[];
}

function buildDeps(opts: ScriptedDepsOptions): { deps: SelfReviewRetryDeps; calls: CallLog } {
  const calls: CallLog = {
    sendFeedback: 0,
    reviewAgent: 0,
    relaunches: 0,
    markStatus: [],
    feedbackBaselines: [],
    fixBaseShas: [],
    waitBaselines: [],
    artifactScopes: [],
    sessionPolicies: [],
    progressDetails: [],
  };
  let reviewIdx = 0;
  let signalIdx = 0;
  const deps: SelfReviewRetryDeps = {
    isWorkerAlive: async () => opts.workerAlive ?? true,
    relaunchWorkerForFix: async () => {
      calls.relaunches += 1;
      return opts.relaunchOk ?? true;
    },
    resumeFixPromptDelivery: async () => ({ status: 'delivered' }),
    ...(opts.contextPct !== undefined
      ? { getWorkerContextPct: async () => opts.contextPct ?? null }
      : {}),
    sendFeedbackToWorker: async (_vars, _issues, _taskDir, _runId, fixBaseSha) => {
      calls.sendFeedback += 1;
      calls.fixBaseShas.push(fixBaseSha);
      const scriptedError = opts.feedbackErrors?.[calls.sendFeedback - 1];
      if (scriptedError) throw scriptedError;
      if (opts.feedbackError) throw new Error(opts.feedbackError);
      // Distinct baseline string per pass — production sendFeedbackToWorker re-reads the
      // (just-cleared) signal file so the next waitForWorkerSignal blocks on a fresh value.
      const baseline = `baseline-${calls.sendFeedback}`;
      calls.feedbackBaselines.push(baseline);
      return { signalBaseline: baseline };
    },
    startProgressWatcher: () => ({ stop: () => {} }),
    waitForWorkerSignal: async (_vars, _taskDir, _timeout, baseline) => {
      calls.waitBaselines.push(baseline);
      const signal = opts.fixSignals?.[signalIdx];
      signalIdx += 1;
      return signal === undefined ? undefined : signal;
    },
    markAgentContextStatus: async (_runId, _role, status) => {
      calls.markStatus.push(status);
    },
    unwatchContext: async () => {},
    captureFixDelta: async (_vars, _taskDir, loopNumber, fixBaseSha, artifactScope) => {
      calls.artifactScopes.push(artifactScope);
      if (opts.fixDeltaUnavailable) {
        return {
          snapshot: {
            source: 'unavailable',
            capturedAt: new Date().toISOString(),
            missingReason: 'git-numstat-failed',
            fixBaseSha,
            fixHeadSha: null,
          },
          artifactPaths: [`artifacts/review-loop-${loopNumber}/fix-delta-stat.json`],
        };
      }
      return {
        snapshot: {
          source: 'local-git',
          capturedAt: new Date().toISOString(),
          fixBaseSha,
          fixHeadSha: `head-${loopNumber}`,
          diffPath: `artifacts/review-loop-${loopNumber}/fix-delta.diff`,
          diffHash: `hash-${loopNumber}`,
          diffStat: {
            files: opts.fixDeltaFiles ?? 1,
            additions: opts.fixDeltaFiles === 0 ? 0 : 2,
            deletions: opts.fixDeltaFiles === 0 ? 0 : 1,
          },
        },
        artifactPaths: [
          `artifacts/review-loop-${loopNumber}/fix-delta.diff`,
          `artifacts/review-loop-${loopNumber}/fix-delta-stat.json`,
        ],
      };
    },
    captureHeadSha: async () => 'base-head',
    restoreWorkerChecklistTargetFromSlot: async () => {},
    setProgressDetail: (_runId, detail) => calls.progressDetails.push(detail),
    runReviewAgent: async (
      _vars,
      runner,
      model,
      _taskDir,
      _slotId,
      _runId,
      _reviewTimeoutMs,
      loopNumber = 1,
      _validationDepth,
      artifactScope,
      sessionPolicy,
    ) => {
      calls.artifactScopes.push(artifactScope);
      calls.sessionPolicies.push(sessionPolicy);
      calls.reviewAgent += 1;
      const scripted = opts.reviewVerdicts[reviewIdx] ?? 'issues';
      reviewIdx += 1;
      // 'incomplete' models readReviewFeedback's placeholder result when the
      // reviewer exits without writing feedback: verdict 'pass' + incomplete.
      const incomplete = scripted === 'incomplete';
      const verdict = incomplete ? 'pass' : scripted;
      const startedAt = new Date().toISOString();
      const completedAt = new Date(Date.now() + 1).toISOString();
      return {
        verdict,
        ...(incomplete ? { incomplete: true } : {}),
        issues: verdict === 'pass' ? [] : ISSUES,
        timeline: [
          {
            kind: loopNumber > 1 ? 're-review' : 'review',
            loopNumber,
            runner,
            model,
            startedAt,
            completedAt,
            durationMs: 1,
            verdict,
            unresolvedCount: verdict === 'pass' ? 0 : ISSUES.length,
          },
        ],
      };
    },
    getRun: () =>
      ({
        metrics: { model: 'sonnet' },
        agentContexts: [
          {
            id: 'fix-context',
            role: 'self-review-fix',
            status: 'working',
            taskFile: 'tasks/foo/SELF-REVIEW-FIX.md',
            signalFile: 'tasks/foo/SELF-REVIEW-FIX-SIGNAL.json',
            runner: 'claude',
            model: 'sonnet',
            attemptStartedAt: '2026-08-05T00:00:00.000Z',
            startedAt: '2026-08-05T00:00:00.000Z',
            target: { session: 'worker', target: 'worker:dev' },
          },
        ],
      }) as any,
  };
  return { deps, calls };
}

const baseArgs = {
  vars: fakeVars,
  taskDir: 'tasks/foo',
  slotId: 'slot-1',
  runId: 'run-12345678',
  start: Date.now(),
  workerRunner: 'claude',
  reviewRunner: 'claude',
  model: 'sonnet',
  reviewTimeoutMs: 15 * 60_000,
};

test('runSelfReviewRetryLoop: incomplete re-review surfaces as skipped, not a false pass', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: ['incomplete'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES } satisfies ReviewAgentResult,
    retryCount: 0,
    deps,
  });

  assert.equal(result.skipped, true, 'incomplete re-review must not clear unresolved issues');
  assert.equal(result.reason, 'no-feedback-file');
  assert.notEqual(result.verdict, 'pass');
});

test('runSelfReviewRetryLoop: exhausts retries when every re-review still finds issues', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues', 'issues', 'issues'],
    fixSignals: [
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES } satisfies ReviewAgentResult,
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'issues');
  assert.equal(result.retryCount, 3);
  assert.equal(
    result.feedbackSent,
    false,
    'the final unresolved generation has not yet been sent even though earlier generations were',
  );
  assert.equal(result.recoveryContinuationPending, true);
  assert.equal(calls.sendFeedback, 3, 'three fix passes sent (one per retry slot)');
  assert.equal(
    calls.reviewAgent,
    3,
    're-review runs after every fix pass; the maxRetries gate trips on the next while-check, after pass 3',
  );
});

test('runSelfReviewRetryLoop: a failed mid-loop relaunch drops a prior generation feedbackSent', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    workerAlive: false,
    relaunchOk: false,
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 1,
    feedbackAlreadySent: true,
    deps,
  });

  assert.equal(result.verdict, 'issues');
  assert.equal(
    result.feedbackSent,
    false,
    'these findings never reached a worker; a prior generation must not suppress continuation',
  );
  assert.equal(result.recoveryContinuationPending, true);
  assert.equal(calls.relaunches, 1);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: a failed high-context relaunch drops a prior generation feedbackSent', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    contextPct: 95,
    relaunchOk: false,
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 1,
    feedbackAlreadySent: true,
    deps,
  });

  assert.equal(result.feedbackSent, false);
  assert.equal(result.recoveryContinuationPending, true);
  assert.equal(calls.relaunches, 1);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: stops as soon as a re-review verdict is pass', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.retryCount, 1);
  assert.equal(result.feedbackSent, true);
  assert.equal(calls.sendFeedback, 1);
  assert.deepEqual(calls.fixBaseShas, ['base-head']);
  assert.match(calls.progressDetails[0] ?? '', /worker applying fixes/);
  assert.match(calls.progressDetails[1] ?? '', /running claude re-review/);
  assert.equal(result.attempts?.length, 2);
  assert.equal(result.attempts?.[1]?.fixDelta?.fixBaseSha, 'base-head');
  assert.equal(result.attempts?.[1]?.fixDelta?.diffPath, 'artifacts/review-loop-2/fix-delta.diff');
});

test('runSelfReviewRetryLoop: rethrows non-delivery failures from worker feedback', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: [],
    feedbackError: 'retired worker pane',
  });

  await assert.rejects(
    runSelfReviewRetryLoop({
      ...baseArgs,
      maxRetries: 1,
      reviewResult: { verdict: 'issues', issues: ISSUES },
      retryCount: 0,
      deps,
    }),
    /retired worker pane/,
  );
});

test('runSelfReviewRetryLoop: relaunches once when the retained worker rejects fix delivery', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    feedbackErrors: [new SelfReviewFixDeliveryError('unacknowledged retained handoff')],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.feedbackSent, true);
  assert.equal(calls.relaunches, 1);
  assert.equal(calls.sendFeedback, 1);
});

test('runSelfReviewRetryLoop: relaunches a high-context worker before sending the fix task', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues', 'pass'],
    contextPct: 93,
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: await deps.runReviewAgent(fakeVars, 'claude', 'sonnet', 't', 's', 'r', 1),
    retryCount: 0,
    deps,
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(calls.relaunches, 1); // worker alive but saturated → fresh session first
  assert.equal(calls.sendFeedback, 1);
});

test('runSelfReviewRetryLoop: low-context and unknown-context workers are not relaunched', async () => {
  for (const contextPct of [40, null]) {
    const { deps, calls } = buildDeps({
      reviewVerdicts: ['issues', 'pass'],
      contextPct,
      fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
    });
    const result = await runSelfReviewRetryLoop({
      ...baseArgs,
      maxRetries: 2,
      reviewResult: await deps.runReviewAgent(fakeVars, 'claude', 'sonnet', 't', 's', 'r', 1),
      retryCount: 0,
      deps,
    });
    assert.equal(result.verdict, 'pass');
    assert.equal(calls.relaunches, 0);
  }
});

test('runSelfReviewRetryLoop: failed high-context relaunch skips feedback instead of sending into a wedged session', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues'],
    contextPct: 95,
    relaunchOk: false,
  });
  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: await deps.runReviewAgent(fakeVars, 'claude', 'sonnet', 't', 's', 'r', 1),
    retryCount: 0,
    deps,
  });
  assert.equal(result.verdict, 'issues');
  assert.equal(calls.relaunches, 1);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: continues after a fix-signal timeout when budget remains', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'], // second iteration's re-review passes
    fixSignals: [
      undefined, // first iteration times out
      { status: 'complete', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.retryCount, 2);
  assert.equal(calls.sendFeedback, 2);
  assert.deepEqual(calls.markStatus, ['failed', 'complete']);
});

test('runSelfReviewRetryLoop: returns blocked without re-review when a blocked fix changed nothing', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    fixDeltaFiles: 0,
    fixSignals: [
      { status: 'blocked', reason: 'pre-flight blocker', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.reason, 'pre-flight blocker');
  assert.equal(result.retryCount, 1);
  assert.equal(result.feedbackSent, true);
  assert.equal(calls.sendFeedback, 1);
  assert.equal(result.attempts?.length, 2);
  assert.equal(result.attempts?.[1]?.verdict, 'failed');
  assert.equal(result.attempts?.[1]?.fixDelta?.diffHash, 'hash-2');
  assert.equal(calls.reviewAgent, 0);
});

test('runSelfReviewRetryLoop: re-reviews partial changes before preserving a worker blocker', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [
      { status: 'blocked', reason: 'live recipe unavailable', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.reason, 'live recipe unavailable');
  assert.deepEqual(result.issues, []);
  assert.equal(calls.reviewAgent, 1);
  // The publication gate reads the FINAL attempt, so a passing re-review must
  // not leave a `pass` attempt behind a blocked verdict.
  assert.equal(result.attempts?.[1]?.verdict, 'failed');
  assert.equal(result.attempts?.[1]?.reason, 'live recipe unavailable');
  assert.deepEqual(
    result.attempts?.[1]?.timeline?.map((segment) => segment.kind),
    ['worker-fix', 're-review'],
  );
});

test('runSelfReviewRetryLoop: an unreadable fix delta still forces the re-review', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixDeltaUnavailable: true,
    fixSignals: [
      { status: 'blocked', reason: 'slot lost its git index', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  // `unavailable` means unknown, not empty: the worker may have changed files.
  assert.equal(calls.reviewAgent, 1);
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.attempts?.[1]?.verdict, 'failed');
});

test('runSelfReviewRetryLoop: bails when worker is dead and relaunch fails', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    workerAlive: false,
    relaunchOk: false,
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'issues');
  assert.equal(result.retryCount, 0);
  assert.equal(result.feedbackSent, false);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: maxRetries=0 short-circuits without sending feedback', async () => {
  const { deps, calls } = buildDeps({ reviewVerdicts: [] });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 0,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'issues');
  assert.equal(result.retryCount, 0);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: forwards a fresh baseline to waitForWorkerSignal on every iteration', async () => {
  // Protects the "every retry gets its own timeout" invariant the PR is named after — if
  // sendFeedbackToWorker's return value ever stops flowing into waitForWorkerSignal, retry
  // N+1 would short-circuit on the previous iteration's signal.
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues', 'issues', 'pass'],
    fixSignals: [
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(calls.sendFeedback, 3);
  assert.deepEqual(calls.feedbackBaselines, ['baseline-1', 'baseline-2', 'baseline-3']);
  assert.deepEqual(
    calls.waitBaselines,
    ['baseline-1', 'baseline-2', 'baseline-3'],
    'each iteration must forward the just-issued baseline, not a leftover from the prior pass',
  );
});

test('runSelfReviewRetryLoop: seeded retryCount does not imply feedback was sent', async () => {
  const { deps, calls } = buildDeps({ reviewVerdicts: [] });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'pass', issues: [] },
    retryCount: 1,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.retryCount, 1);
  assert.equal(result.feedbackSent, false);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: resumed attempts keep history and advance artifact numbering', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  const priorAttempts = [
    { loopNumber: 1, verdict: 'issues' as const, unresolvedCount: 1 },
    { loopNumber: 2, verdict: 'issues' as const, unresolvedCount: 1 },
  ];

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 1,
    priorAttempts,
    deps,
  });

  assert.deepEqual(
    result.attempts?.map((attempt) => attempt.loopNumber),
    [1, 2, 3],
  );
  assert.equal(result.attempts?.[2]?.fixDelta?.diffPath, 'artifacts/review-loop-3/fix-delta.diff');
});

test('runSelfReviewRetryLoop: recovery path can mark prior feedback as already sent', async () => {
  // Mirrors recoverSelfReviewFixPass: a fix pass already happened before we entered the loop.
  // If the seeded re-review verdict is `pass`, the loop should not iterate and retryCount stays at 1.
  const { deps, calls } = buildDeps({ reviewVerdicts: [] });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 3,
    reviewResult: { verdict: 'pass', issues: [] },
    retryCount: 1,
    feedbackAlreadySent: true,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.retryCount, 1);
  assert.equal(result.feedbackSent, true);
  assert.equal(calls.sendFeedback, 0);
});

test('runSelfReviewRetryLoop: forwards artifactScope to fix deltas and re-review attempts', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    artifactScope: 'independent-review-7',
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(calls.artifactScopes, ['independent-review-7', 'independent-review-7']);
});

test('runSelfReviewRetryLoop: records worker-fix timeline segment before re-review', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: {
      verdict: 'issues',
      issues: ISSUES,
      timeline: [
        {
          kind: 'review',
          loopNumber: 1,
          runner: 'codex',
          model: 'gpt-5.5',
          startedAt: '2026-05-08T00:00:00.000Z',
          completedAt: '2026-05-08T00:01:00.000Z',
          durationMs: 60_000,
        },
      ],
    },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.timeline?.[0]?.kind, 'review');
  assert.equal(result.timeline?.[1]?.kind, 'worker-fix');
  assert.equal(result.timeline?.[2]?.kind, 're-review');
  assert.equal(typeof result.timeline?.[1]?.durationMs, 'number');
});

test('runSelfReviewRetryLoop threads sessionPolicy into every re-review launch', async () => {
  // The retry loop is the code that actually relaunches reviewers, so it must
  // forward the resolved policy to runReviewAgent — and default to
  // warm-per-reviewer when the caller omits it — or re-reviews rebuild the
  // whole review from scratch after every worker fix.
  const warm = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    sessionPolicy: 'warm-per-reviewer',
    deps: warm.deps,
  });
  assert.deepEqual(warm.calls.sessionPolicies, ['warm-per-reviewer']);

  const dflt = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  await runSelfReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps: dflt.deps,
  });
  assert.deepEqual(dflt.calls.sessionPolicies, ['warm-per-reviewer']);
});

test('retryDeferredFixDelivery adopts the re-resolved pane when the stored target is dead', async () => {
  // Stored target points at a bare pane; the live accepting runner sits in a
  // different window of the same session. Every send to the stored target
  // defers, so delivery must succeed via re-resolution.
  const sends: string[] = [];
  const persisted: Array<{ target: string; window: string | null }> = [];
  const result = await retryDeferredFixDelivery({
    runId: 'run-rediscovery-1',
    target: 'coredev-1:dev',
    send: async (target) => {
      sends.push(target);
      return target === 'coredev-1:zsh.0';
    },
    rediscover: async () => ({
      target: 'coredev-1:zsh.0',
      window: 'zsh',
      seenWindows: ['1:dev pane 0 (zsh)', '2:zsh pane 0 (claude)'],
    }),
    persistTarget: async (target, window) => {
      persisted.push({ target, window });
    },
    getRun: (() => ({ status: 'working' })) as any,
    retryIntervalMs: 1,
    retryWindowMs: 5_000,
  });
  assert.equal(result.sent, true);
  assert.equal(result.target, 'coredev-1:zsh.0');
  assert.deepEqual(sends, ['coredev-1:zsh.0']);
  assert.deepEqual(persisted, [{ target: 'coredev-1:zsh.0', window: 'zsh' }]);
});

test('retryDeferredFixDelivery keeps the stored target when re-resolution confirms it', async () => {
  const sends: string[] = [];
  let persistCalls = 0;
  const result = await retryDeferredFixDelivery({
    runId: 'run-rediscovery-2',
    target: 'coredev-1:dev',
    send: async (target) => {
      sends.push(target);
      return sends.length >= 2;
    },
    rediscover: async (storedTarget) => ({
      target: storedTarget,
      window: 'dev',
      seenWindows: ['1:dev pane 0 (claude)'],
    }),
    persistTarget: async () => {
      persistCalls += 1;
    },
    getRun: (() => ({ status: 'working' })) as any,
    retryIntervalMs: 1,
    retryWindowMs: 5_000,
  });
  assert.equal(result.sent, true);
  assert.deepEqual(sends, ['coredev-1:dev', 'coredev-1:dev']);
  assert.equal(persistCalls, 0);
});

test('retryDeferredFixDelivery reports the inspected windows when no pane ever accepts', async () => {
  const result = await retryDeferredFixDelivery({
    runId: 'run-rediscovery-3',
    target: 'coredev-1:dev',
    send: async () => false,
    rediscover: async () => ({
      target: null,
      window: null,
      seenWindows: ['1:dev pane 0 (zsh)', '2:zsh pane 0 (zsh)'],
    }),
    persistTarget: async () => {},
    getRun: (() => ({ status: 'working' })) as any,
    retryIntervalMs: 1,
    retryWindowMs: 30,
  });
  assert.equal(result.sent, false);
  assert.equal(result.target, 'coredev-1:dev');
  assert.deepEqual(result.seenWindows, ['1:dev pane 0 (zsh)', '2:zsh pane 0 (zsh)']);
});

test('retryDeferredFixDelivery bails when the run reaches a terminal status', async () => {
  let sendCalls = 0;
  const result = await retryDeferredFixDelivery({
    runId: 'run-rediscovery-4',
    target: 'coredev-1:dev',
    send: async () => {
      sendCalls += 1;
      return false;
    },
    rediscover: async () => ({ target: null, window: null, seenWindows: [] }),
    persistTarget: async () => {},
    getRun: (() => ({ status: 'cancelled' })) as any,
    retryIntervalMs: 1,
    retryWindowMs: 5_000,
  });
  assert.equal(result.sent, false);
  assert.equal(sendCalls, 0);
});

test('retryDeferredFixDelivery stops immediately after retained delivery becomes terminal', async () => {
  let terminal = false;
  let rediscoverCalls = 0;
  const result = await retryDeferredFixDelivery({
    runId: 'run-rediscovery-5',
    target: 'coredev-1:dev',
    send: async () => {
      terminal = true;
      return false;
    },
    rediscover: async () => {
      rediscoverCalls += 1;
      return { target: null, window: null, seenWindows: [] };
    },
    persistTarget: async () => {},
    getRun: (() => ({ status: 'working' })) as any,
    shouldAbort: () => terminal,
    retryIntervalMs: 1,
    retryWindowMs: 5_000,
  });
  assert.equal(result.sent, false);
  assert.equal(rediscoverCalls, 1);
});
