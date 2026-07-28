import assert from 'node:assert/strict';
import test from 'node:test';

import type { SelfReviewIssue, WorkerSignal } from '@farmslot/protocol';

import { parseSelfReviewIssueBullets } from './issues.js';
import {
  canRecoverSelfReviewFixPass,
  resolveSelfReviewRunnerModel,
  retryDeferredFixDelivery,
  runSelfReviewRetryLoop,
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
    { reviewRunner: 'codex', model: 'gpt-5.5', crossRunner: true },
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
}

interface CallLog {
  sendFeedback: number;
  reviewAgent: number;
  relaunches: number;
  markStatus: string[];
  feedbackBaselines: string[]; // baseline returned to the loop on each sendFeedbackToWorker call
  waitBaselines: string[]; // baseline forwarded into waitForWorkerSignal on each iteration
  artifactScopes: Array<string | null | undefined>;
  sessionPolicies: Array<string | undefined>; // 11th runReviewAgent arg per re-review
}

function buildDeps(opts: ScriptedDepsOptions): { deps: SelfReviewRetryDeps; calls: CallLog } {
  const calls: CallLog = {
    sendFeedback: 0,
    reviewAgent: 0,
    relaunches: 0,
    markStatus: [],
    feedbackBaselines: [],
    waitBaselines: [],
    artifactScopes: [],
    sessionPolicies: [],
  };
  let reviewIdx = 0;
  let signalIdx = 0;
  const deps: SelfReviewRetryDeps = {
    isWorkerAlive: async () => opts.workerAlive ?? true,
    relaunchWorkerForFix: async () => {
      calls.relaunches += 1;
      return opts.relaunchOk ?? true;
    },
    ...(opts.contextPct !== undefined
      ? { getWorkerContextPct: async () => opts.contextPct ?? null }
      : {}),
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
    restoreWorkerChecklistTargetFromSlot: async () => {},
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

test('runSelfReviewRetryLoop threads sessionPolicy into every re-review launch', async () => {
  // The retry loop is the code that actually relaunches reviewers, so it must
  // forward the resolved policy to runReviewAgent — and default to
  // fresh-per-pass when the caller omits it — or warm mode silently never
  // applies to re-reviews.
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
  assert.deepEqual(dflt.calls.sessionPolicies, ['fresh-per-pass']);
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
