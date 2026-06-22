import assert from 'node:assert/strict';
import test from 'node:test';

import type { SelfReviewIssue, WorkerSignal } from '@farmslot/protocol';

import { parseSelfReviewIssueBullets } from './issues.js';
import {
  canRecoverSelfReviewFixPass,
  resolveSelfReviewRunnerModel,
  runSelfReviewRetryLoop,
  type SelfReviewRetryDeps,
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

test('canRecoverSelfReviewFixPass requires a working context for the current fix task', () => {
  const current = {
    role: 'self-review-fix',
    status: 'working',
    taskFile: 'tasks/foo/SELF-REVIEW-FIX.md',
    signalFile: 'tasks/foo/SELF-REVIEW-FIX-SIGNAL.json',
  } as const;

  assert.equal(canRecoverSelfReviewFixPass(current, 'tasks/foo'), true);
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

test('resolveSelfReviewRunnerModel keeps self-review on the worker runner by default', () => {
  assert.deepEqual(
    resolveSelfReviewRunnerModel(
      'cursor',
      'composer-2.5',
      { runner: 'same', model: 'opus' },
      {},
    ),
    { reviewRunner: 'cursor', model: 'composer-2.5', crossRunner: false },
  );
});

test('resolveSelfReviewRunnerModel supports explicit cross-runner review overrides', () => {
  assert.deepEqual(
    resolveSelfReviewRunnerModel(
      'cursor',
      'composer-2.5',
      { runner: 'same', model: 'opus' },
      { reviewRunner: 'claude' },
    ),
    { reviewRunner: 'claude', model: 'opus', crossRunner: true },
  );
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
  reviewVerdicts: Array<'pass' | 'issues'>;
  workerAlive?: boolean;
  relaunchOk?: boolean;
  fixSignals?: Array<WorkerSignal | undefined>; // undefined = timeout
}

interface CallLog {
  sendFeedback: number;
  reviewAgent: number;
  markStatus: string[];
  feedbackBaselines: string[]; // baseline returned to the loop on each sendFeedbackToWorker call
  waitBaselines: string[]; // baseline forwarded into waitForWorkerSignal on each iteration
  artifactScopes: Array<string | null | undefined>;
}

function buildDeps(opts: ScriptedDepsOptions): { deps: SelfReviewRetryDeps; calls: CallLog } {
  const calls: CallLog = {
    sendFeedback: 0,
    reviewAgent: 0,
    markStatus: [],
    feedbackBaselines: [],
    waitBaselines: [],
    artifactScopes: [],
  };
  let reviewIdx = 0;
  let signalIdx = 0;
  const deps: SelfReviewRetryDeps = {
    isWorkerAlive: async () => opts.workerAlive ?? true,
    relaunchWorkerForFix: async () => opts.relaunchOk ?? true,
    sendFeedbackToWorker: async () => {
      calls.sendFeedback += 1;
      // Distinct baseline string per pass — production sendFeedbackToWorker re-reads the
      // (just-cleared) signal file so the next waitForWorkerSignal blocks on a fresh value.
      const baseline = `baseline-${calls.sendFeedback}`;
      calls.feedbackBaselines.push(baseline);
      return baseline;
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
      return {
        snapshot: {
          source: 'local-git',
          capturedAt: new Date().toISOString(),
          fixBaseSha,
          fixHeadSha: `head-${loopNumber}`,
          diffPath: `artifacts/review-loop-${loopNumber}/fix-delta.diff`,
          diffHash: `hash-${loopNumber}`,
          diffStat: { files: 1, additions: 2, deletions: 1 },
        },
        artifactPaths: [
          `artifacts/review-loop-${loopNumber}/fix-delta.diff`,
          `artifacts/review-loop-${loopNumber}/fix-delta-stat.json`,
        ],
      };
    },
    captureHeadSha: async () => 'base-head',
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
    ) => {
      calls.artifactScopes.push(artifactScope);
      calls.reviewAgent += 1;
      const verdict = opts.reviewVerdicts[reviewIdx] ?? 'issues';
      reviewIdx += 1;
      const startedAt = new Date().toISOString();
      const completedAt = new Date(Date.now() + 1).toISOString();
      return {
        verdict,
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
    getRun: () => ({ metrics: { model: 'sonnet' } }) as any,
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
  assert.equal(result.feedbackSent, true);
  assert.equal(calls.sendFeedback, 3, 'three fix passes sent (one per retry slot)');
  assert.equal(
    calls.reviewAgent,
    3,
    're-review runs after every fix pass; the maxRetries gate trips on the next while-check, after pass 3',
  );
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
  assert.equal(result.attempts?.length, 2);
  assert.equal(result.attempts?.[1]?.fixDelta?.fixBaseSha, 'base-head');
  assert.equal(result.attempts?.[1]?.fixDelta?.diffPath, 'artifacts/review-loop-2/fix-delta.diff');
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

test('runSelfReviewRetryLoop: returns blocked when fix signal reports blocked', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
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
