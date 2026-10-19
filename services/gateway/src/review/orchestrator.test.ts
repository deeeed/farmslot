import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, ReviewIssue, WorkerSignal } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { runnerPromptDigest } from '../runners/observability-prompt-digest.js';

import { parseReviewIssueBullets } from './issues.js';
import {
  canRecoverReviewFixPass,
  canSettleRecoveredFixContext,
  reconcileRecoveredFixPromptDelivery,
  resolveRecoveredFixBaseSha,
  resolveReviewMaxRetries,
  resolveReviewRunnerModel,
  resumeReviewFixPromptDelivery,
  retryDeferredFixDelivery,
  ReviewFixDeliveryError,
  type ReviewRetryDeps,
  runReviewRetryLoop,
  shouldSkipForDisabledReviewConfig,
} from './orchestrator.js';
import type { ReviewAgentResult } from './review-agent.js';

test('deferred handoffs name a missing prior-task receipt instead of claiming worker activity', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const reason =
    'Live cursor prior task is not terminal at REVIEW-FIX-SIGNAL.json; refusing process replacement';
  const run = makeRun({ status: 'monitoring' });
  const result = await retryDeferredFixDelivery({
    runId: run.id,
    target: 'fixture:dev',
    send: async () => true,
    rediscover: async () => ({ target: 'fixture:dev', window: 'dev', seenWindows: [] }),
    persistTarget: async () => {},
    getRun: () => run,
    deferredReason: () => reason,
    retryIntervalMs: 1,
    retryWindowMs: 100,
  });
  assert.equal(result.sent, true);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes(reason));
  assert.ok(!warnings[0]?.includes('worker busy'));
});

test('recovered fix delivery prepares declared capabilities before sending any instruction', async () => {
  const events: string[] = [];
  let refuse = true;
  const context = {
    id: 'review-fix',
    runner: 'claude',
    model: 'opus',
    taskFile: 'tasks/REVIEW-FIX.md',
    attemptStartedAt: '2026-10-12T00:00:00.000Z',
    target: { session: 'session', target: 'session:worker' },
  };
  const deps = {
    getRun: (() => ({
      id: 'run-1',
      project: 'test-project',
      metrics: { runner: 'claude' },
    })) as never,
    prepareCapabilities: async () => {
      events.push('prepare');
      if (refuse) throw new Error('declared resource unavailable');
    },
    resolvePrompt: async () => 'read tasks/REVIEW-FIX.md',
    resolveRuntimeDir: async () => '.agent',
    readLaunchAck: async () => null,
    syncChecklistTarget: async () => {
      events.push('checklist');
    },
    ensureTarget: async () => 'session:worker',
    persistTarget: async () => {},
    deliver: async () => {
      events.push('deliver');
      return { delivered: true as const, acknowledgement: 'safe-send' as const };
    },
  };
  await assert.rejects(
    resumeReviewFixPromptDelivery({ remoteRepo: '/repo' } as never, 'run-1', context, deps),
    /declared resource unavailable/,
  );
  assert.deepEqual(events, ['prepare']);
  refuse = false;
  events.length = 0;
  assert.equal(
    (await resumeReviewFixPromptDelivery({ remoteRepo: '/repo' } as never, 'run-1', context, deps))
      .status,
    'delivered',
  );
  assert.equal(events[0], 'prepare');
  assert.equal(events.at(-1), 'deliver');
});

test('recovery binds a completed fix when its running signal was missed, but never a successor', () => {
  const context: AgentContext = {
    id: 'review-fix',
    role: 'review-fix',
    runId: 'run-1',
    slotId: 'slot-1',
    label: 'Fix',
    status: 'working',
    updatedAt: '2026-09-22T10:00:00Z',
    taskFile: 'task/REVIEW-FIX.md',
    signalFile: 'task/REVIEW-FIX-SIGNAL.json',
    attemptStartedAt: '2026-09-22T10:00:00Z',
    promptDeliveryStartedAt: '2026-09-22T10:00:01Z',
  };
  assert.equal(canSettleRecoveredFixContext(context, context, 'completed-attempt'), true);
  assert.equal(canSettleRecoveredFixContext(context, context, undefined), true);
  assert.equal(
    canSettleRecoveredFixContext(
      { ...context, signalAttemptId: 'completed-attempt' },
      context,
      'completed-attempt',
    ),
    true,
  );
  for (const changed of [
    { signalAttemptId: 'successor' },
    { attemptStartedAt: '2026-09-22T11:00:00Z' },
    { promptDeliveryStartedAt: '2026-09-22T11:00:01Z' },
    { taskFile: 'other/REVIEW-FIX.md' },
    { signalFile: 'other/SIGNAL.json' },
    { artifactScope: 'review-2' },
  ]) {
    assert.equal(
      canSettleRecoveredFixContext({ ...context, ...changed }, context, 'completed-attempt'),
      false,
    );
  }
});

test('parseReviewIssueBullets recovers issues from REVIEW-FIX.md', () => {
  const issues = parseReviewIssueBullets(`
## Issues Found by Review

- **modal-footer.test.tsx:9** — remove should from test name.
- **src/no-line.ts** — explain issue without a line.
`);

  assert.deepEqual(issues, [
    { file: 'modal-footer.test.tsx', line: 9, description: 'remove should from test name.' },
    { file: 'src/no-line.ts', line: undefined, description: 'explain issue without a line.' },
  ]);
});

test('parseReviewIssueBullets accepts review-feedback backtick locations', () => {
  const issues = parseReviewIssueBullets(`
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

test('parseReviewIssueBullets ignores bullets outside the Issues section', () => {
  const issues = parseReviewIssueBullets(`
# Review: MANUAL-000014

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

test('parseReviewIssueBullets parses numbered title-style items', () => {
  const issues = parseReviewIssueBullets(`
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

test('parseReviewIssueBullets ignores fenced code blocks and placeholder bullets', () => {
  const issues = parseReviewIssueBullets(`
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

test('parseReviewIssueBullets survives headings and fences inside the Issues section', () => {
  const issues = parseReviewIssueBullets(`
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

test('parseReviewIssueBullets strips unterminated fences to end of input', () => {
  const issues = parseReviewIssueBullets(`
## Issues
- **src/a.ts:1** — real finding

\`\`\`diff
- **phantom.ts:5** — inside an unterminated fence
`);

  assert.deepEqual(issues, [{ file: 'src/a.ts', line: 1, description: 'real finding' }]);
});

test('parseReviewIssueBullets accepts CommonMark 1-3 space indentation', () => {
  const issues = parseReviewIssueBullets(
    '  ## Issues\n' + '   - **src/indented.ts:7** — heading and bullet both indented\n',
  );

  assert.deepEqual(issues, [
    { file: 'src/indented.ts', line: 7, description: 'heading and bullet both indented' },
  ]);
});

test('parseReviewIssueBullets prefers path-looking backtick tokens for title-style items', () => {
  const issues = parseReviewIssueBullets(`
## Issues
1. **\`resolveFoo\` is wrong.** See \`src/foo.ts:42\` for the call site.
`);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'src/foo.ts');
  assert.equal(issues[0].line, 42);
});

test('parseReviewIssueBullets: inner fence-with-info lines do not close an open fence', () => {
  const issues = parseReviewIssueBullets(`
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

test('parseReviewIssueBullets folds nested sub-bullets but splits uniformly indented lists', () => {
  const nested = parseReviewIssueBullets(`
## Issues
- **src/a.ts:1** — finding with evidence
  - nested evidence bullet
  - more evidence
- **src/b.ts:2** — second finding
`);
  assert.equal(nested.length, 2);
  assert.match(nested[0].description, /nested evidence bullet/);

  const uniform = parseReviewIssueBullets(
    '## Issues\n' + '   - **src/a.ts:1** — first\n' + '   - **src/b.ts:2** — second\n',
  );
  assert.deepEqual(
    uniform.map((i) => i.file),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('parseReviewIssueBullets ranks slash/:line tokens above extension-only tokens', () => {
  const issues = parseReviewIssueBullets(`
## Issues
1. **The \`foo.bar\` config key is stale.** Real location is \`src/foo.ts:42\`.
`);

  assert.equal(issues[0].file, 'src/foo.ts');
  assert.equal(issues[0].line, 42);
});

test('parseReviewIssueBullets falls back to whole document without an Issues heading', () => {
  const issues = parseReviewIssueBullets(`
- **src/legacy.ts:3** — legacy artifact without sections.
`);

  assert.deepEqual(issues, [
    { file: 'src/legacy.ts', line: 3, description: 'legacy artifact without sections.' },
  ]);
});

test('canRecoverReviewFixPass requires a working context for the current fix task', () => {
  const current = {
    role: 'review-fix',
    status: 'working',
    taskFile: 'tasks/foo/REVIEW-FIX.md',
    signalFile: 'tasks/foo/REVIEW-FIX-SIGNAL.json',
    artifactScope: 'review-4',
  } as const;

  assert.equal(canRecoverReviewFixPass(current, 'tasks/foo'), true);
  assert.equal(
    canRecoverReviewFixPass(current, 'tasks/foo', 'review-4'),
    true,
    'a fix context owned by the current findings generation is recoverable',
  );
  assert.equal(
    canRecoverReviewFixPass({ ...current, artifactScope: null }, 'tasks/foo', 'review-4'),
    true,
    'an in-flight context created before generation ownership can be bound during recovery',
  );
  assert.equal(
    canRecoverReviewFixPass(current, 'tasks/foo', 'review-5'),
    false,
    'a fix context owned by another findings generation must not be recovered',
  );
  assert.equal(canRecoverReviewFixPass(null, 'tasks/foo'), false);
  assert.equal(
    canRecoverReviewFixPass({ ...current, status: 'complete' }, 'tasks/foo'),
    false,
    'completed fix contexts must not resurrect a stale signal',
  );
  assert.equal(
    canRecoverReviewFixPass({ ...current, taskFile: 'tasks/bar/REVIEW-FIX.md' }, 'tasks/foo'),
    false,
    'a fix for another task dir is not valid recovery state',
  );
  assert.equal(
    canRecoverReviewFixPass({ ...current, signalFile: null }, 'tasks/foo'),
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
            reviews: [
              {
                id: 'review-4',
                reviewSnapshot: { source: 'local-git', capturedAt: '', headSha: 'review-head' },
              },
            ],
          },
        },
      } as never,
      { artifactScope: 'review-4', deliveryBaselineRef: 'delivery-head' },
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
            reviews: [
              {
                id: 'review-4',
                reviewSnapshot: { source: 'local-git', capturedAt: '', headSha: 'review-head' },
              },
            ],
          },
        },
      } as never,
      { artifactScope: 'review-4' },
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
  const result = await resumeReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'cursor',
      model: 'cursor-grok-4.6-high-fast',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
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
        assert.match(options.prompt, /REVIEW-FIX\.md/);
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
  const result = await resumeReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'claude',
      model: 'opus',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
      target: { session: 'ff-1', window: 'bugfix', target: 'ff-1:bugfix' },
      startedAt: '2026-08-03T12:00:00.000Z',
      attemptStartedAt: '2026-08-04T08:15:00.000Z',
    },
    {
      getRun: (() => run) as never,
      resolvePrompt: async (_project, input) => `read ${input.taskFile}`,
      resolveRuntimeDir: async () => '.sandbox/farmslot-farm/agent',
      readLaunchAck: async (_vars, signalPath) => {
        assert.equal(signalPath, '/repo/tasks/run-1/REVIEW-FIX-SIGNAL.json');
        return null;
      },
      syncChecklistTarget: async (_vars, taskDir, role) => {
        assert.equal(taskDir, 'tasks/run-1');
        assert.equal(role, 'review-fix');
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
        assert.match(
          options.prompt,
          /^Farmslot fix delivery \d{4}-\d\d-\d\dT[\d:.]+Z\.\n\nread tasks\/run-1\/REVIEW-FIX\.md\n\n/,
        );
        assert.match(
          options.prompt,
          /tasks\/run-1\/mark --checklist REVIEW-FIX\.md --signal REVIEW-FIX-SIGNAL\.json start/,
        );
        assert.match(options.prompt, /complete --mark-last/);
        assert.match(options.prompt, /no-change --reason/);
        assert.match(options.prompt, /blocked --reason/);
        assert.doesNotMatch(options.prompt, /2026-08-04T08:15:00/, 'mark start rewrites attempts');
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

test('restart recovery adopts a fix delivery the busy worker already acknowledged', async () => {
  // TAT-4145 grok run 6c5d56fb: the worker took this delivery at 09:14Z and was on step 3 when
  // the 09:36Z restart came. Re-probing it timed out and a new fix pass reset its checklist.
  const deliveryStartedAt = '2026-10-18T09:14:15.302Z';
  const turnToken = '01a14d96-c35d-7cb3-8849-e5bc94b1638d:1792314858624';
  const sessionPath =
    '/Users/deeeed/.grok/sessions/%2FUsers%2Fdeeeed%2Fdev%2Fmetamask%2Fva-mmcx-terminal-3/01a14d96-c35d-7cb3-8849-e5bc94b1638d';
  const result = await resumeReviewFixPromptDelivery(
    { remoteRepo: '/Users/deeeed/dev/metamask/va-mmcx-terminal-3' } as never,
    '6c5d56fb',
    {
      id: 'review-fix',
      runner: 'grok',
      model: 'grok-4.7',
      taskFile: 'temp/tasks/feat/tat-4145-grok-1018-135546/REVIEW-FIX.md',
      signalFile: 'temp/tasks/feat/tat-4145-grok-1018-135546/REVIEW-FIX-SIGNAL.json',
      target: { session: 'mmt-3', window: 'dev', pane: null, target: 'mmt-3:dev' },
      startedAt: '2026-10-18T09:14:15.289Z',
      attemptStartedAt: '2026-10-18T09:16:20.708Z',
      promptDeliveryStartedAt: deliveryStartedAt,
      promptAcceptance: {
        runner: 'grok',
        deliveryStartedAt,
        turnToken,
        observedAt: 1792315024933,
        sessionId: '01a14d96-c35d-7cb3-8849-e5bc94b1638d',
        sessionPath,
      },
    },
    {
      getRun: (() => ({
        id: '6c5d56fb',
        project: 'va-mmcx-terminal-farm',
        flowType: 'dev',
        metrics: { runner: 'grok', model: 'grok-4.7' },
        agentContexts: [],
      })) as never,
      resolvePrompt: async () => 'read REVIEW-FIX.md',
      resolveRuntimeDir: async () => '.agent',
      readLaunchAck: async () => null,
      syncChecklistTarget: async () => {},
      ensureTarget: async () => 'mmt-3:dev',
      persistTarget: async () => {},
      targetHostsRunner: async () => true,
      deliver: async () => {
        throw new Error('An acknowledged fix delivery must not be probed or sent again');
      },
    },
  );
  assert.deepEqual(result, { status: 'delivered', turnToken });
});

test('a recovered fix prompt is the sent text and its receipt never matches another round', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'claude', model: 'opus' },
    agentContexts: [],
  };
  const prompts: string[] = [];
  const deps = {
    getRun: (() => run) as never,
    resolvePrompt: async (_project: string, input: { taskFile: string }) =>
      `read ${input.taskFile}`,
    resolveRuntimeDir: async () => '.sandbox/farmslot-farm/agent',
    readLaunchAck: async () => null,
    syncChecklistTarget: async () => {},
    ensureTarget: async () => 'ff-1:bugfix',
    persistTarget: async () => {},
    deliver: async (options: { prompt: string }) => {
      prompts.push(options.prompt);
      return { delivered: true as const, acknowledgement: 'structured' as const };
    },
  };
  // The worker's mark start rewrote attemptStartedAt after the first round was sent.
  for (const boundary of ['2026-10-16T08:10:27.976Z', '2026-10-16T10:53:17.568Z']) {
    await resumeReviewFixPromptDelivery(
      { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
      'run-1',
      {
        id: 'review-fix',
        runner: 'claude',
        model: 'opus',
        taskFile: 'tasks/run-1/REVIEW-FIX.md',
        signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
        target: { session: 'ff-1', window: 'bugfix', target: 'ff-1:bugfix' },
        attemptStartedAt: '2026-10-16T10:54:03.119Z',
        promptDeliveryStartedAt: boundary,
      },
      deps as never,
    );
  }
  assert.match(prompts[0], /^Farmslot fix delivery 2026-10-16T08:10:27\.976Z\.\n/);
  assert.match(prompts[1], /^Farmslot fix delivery 2026-10-16T10:53:17\.568Z\.\n/);
  assert.notEqual(runnerPromptDigest(prompts[0]), runnerPromptDigest(prompts[1]));
});

test('recovery probes only the identity-led fix prompt and defers while it is unproven', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'claude', model: 'opus' },
    agentContexts: [],
  };
  const calls: Array<{ prompt: string; prior?: boolean }> = [];
  const remembered: string[] = [];
  const boundary = '2026-10-16T10:53:17.568Z';
  const result = await resumeReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'claude',
      model: 'opus',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
      target: { session: 'ff-1', window: 'bugfix', target: 'ff-1:bugfix' },
      attemptStartedAt: '2026-10-16T10:54:03.119Z',
      promptDeliveryStartedAt: boundary,
    },
    {
      getRun: (() => run) as never,
      resolvePrompt: async (_project, input) => `read ${input.taskFile}`,
      resolveRuntimeDir: async () => '.sandbox/farmslot-farm/agent',
      readLaunchAck: async () => null,
      syncChecklistTarget: async () => {},
      ensureTarget: async () => 'ff-1:bugfix',
      persistTarget: async () => {},
      deliver: async (options) => {
        calls.push({ prompt: options.prompt, prior: options.priorPromptSendAttempted });
        return { delivered: false, disposition: 'hold', reason: 'unacknowledged', retryable: true };
      },
      rememberAcceptedTurn: async (_runId, _runner, turnToken) => {
        remembered.push(turnToken);
      },
    },
  );
  // A fix is proven only by its own identity-led receipt; nothing else is probed.
  assert.deepEqual(result, { status: 'deferred' });
  assert.deepEqual(remembered, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prior, true, 'recovery only probes, never resends');
  assert.match(calls[0].prompt, /^Farmslot fix delivery 2026-10-16T10:53:17\.568Z\./);
  assert.doesNotMatch(calls[0].prompt, /Farmslot fix delivery attempt:/);
});

test('restart recovery preserves a persisted fix prompt delivery boundary when the runner exits', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'cursor', model: 'cursor-grok-4.6-high-fast' },
    agentContexts: [],
  };
  const result = await resumeReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'cursor',
      model: 'cursor-grok-4.6-high-fast',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
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
      targetHostsRunner: async () => false,
      deliver: async () => {
        throw new Error('An exited worker must not receive another prompt');
      },
    },
  );
  assert.deepEqual(result, { status: 'blocked' });
});

test('recovered fix stops polling when the worker has exited', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'cursor', model: 'cursor-grok-4.6-high-fast' },
    agentContexts: [],
  };
  let probes = 0;
  const result = await reconcileRecoveredFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      target: { session: 'mm-4', target: 'mm-4:bugfix' },
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
      targetHostsRunner: async () => {
        probes += 1;
        return false;
      },
      deliver: async () => {
        throw new Error('An exited worker must not receive another prompt');
      },
    },
    { retryIntervalMs: 1, retryWindowMs: 100 },
  );
  assert.deepEqual(result, { status: 'blocked' });
  assert.equal(probes, 1);
});

test('recovered fix re-probes the original prompt without another send', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'cursor', model: 'cursor-grok-4.6-high-fast' },
    agentContexts: [],
  };
  let probes = 0;
  const result = await reconcileRecoveredFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'cursor',
      model: 'cursor-grok-4.6-high-fast',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
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
        probes += 1;
        return probes === 2
          ? { delivered: true, acknowledgement: 'structured' }
          : { delivered: false, disposition: 'hold', reason: 'unacknowledged prior send' };
      },
    },
    { retryIntervalMs: 1, retryWindowMs: 100 },
  );
  assert.deepEqual(result, { status: 'delivered' });
  assert.equal(probes, 2);
});

test('recovered fix waits for its signal after the acknowledgement window without resending', async () => {
  let probes = 0;
  const result = await reconcileRecoveredFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'cursor',
      model: 'cursor-grok-4.6-high-fast',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      target: { session: 'mm-4', target: 'mm-4:bugfix' },
      attemptStartedAt: '2026-08-04T08:15:00.000Z',
      promptDeliveryStartedAt: '2026-08-04T08:15:01.000Z',
    },
    {
      getRun: (() => ({
        id: 'run-1',
        project: 'farmslot-farm',
        flowType: 'fix-bug',
        metrics: { runner: 'cursor', model: 'cursor-grok-4.6-high-fast' },
        agentContexts: [],
      })) as never,
      resolvePrompt: async () => 'read fix task',
      resolveRuntimeDir: async () => '.agent',
      readLaunchAck: async () => null,
      syncChecklistTarget: async () => {},
      ensureTarget: async () => 'mm-4:bugfix',
      persistTarget: async () => {},
      targetHostsRunner: async () => true,
      deliver: async (options) => {
        assert.equal(options.priorPromptSendAttempted, true);
        probes += 1;
        return { delivered: false, disposition: 'hold', reason: 'unacknowledged prior send' };
      },
    },
    { retryIntervalMs: 1, retryWindowMs: 5 },
  );
  assert.deepEqual(result, { status: 'deferred' });
  assert.ok(probes > 0);
});

test('recovered fix accepts its terminal signal before re-probing an uncertain send', async () => {
  const result = await reconcileRecoveredFixPromptDelivery(
    {} as never,
    'run-1',
    {} as never,
    {} as never,
    { retryIntervalMs: 1, retryWindowMs: 100, readMatchingSignal: async () => true },
  );
  assert.deepEqual(result, { status: 'signal-present' });
});

test('restart recovery requests a fresh worker after an unacknowledged retained handoff', async () => {
  const run = {
    id: 'run-1',
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    metrics: { runner: 'claude', model: 'opus' },
    agentContexts: [],
  };
  const result = await resumeReviewFixPromptDelivery(
    { remoteRepo: '/repo', projectName: 'farmslot-farm' } as never,
    'run-1',
    {
      id: 'review-fix',
      runner: 'claude',
      model: 'opus',
      taskFile: 'tasks/run-1/REVIEW-FIX.md',
      signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
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

test('review runner defaults come from configuration, independent of the worker', () => {
  assert.deepEqual(resolveReviewRunnerModel({ runner: 'claude', model: 'opus' }), {
    reviewRunner: 'claude',
    model: 'opus',
  });
  assert.equal(resolveReviewRunnerModel({}).reviewRunner, 'codex');
  assert.deepEqual(
    resolveReviewRunnerModel(
      { runner: 'claude', model: 'opus' },
      { reviewRunner: 'codex', model: null },
    ),
    { reviewRunner: 'codex', model: 'gpt-6.1-sol' },
  );
});

test('unqualified project models cannot change the default reviewer', () => {
  assert.deepEqual(resolveReviewRunnerModel({ model: 'opus' }), {
    reviewRunner: 'codex',
    model: 'gpt-6.1-sol',
  });
  assert.throws(
    () => resolveReviewRunnerModel({ runner: 'codex', model: 'opus' }),
    /Review runner 'codex' does not support model 'opus'/,
  );
  assert.throws(
    () => resolveReviewRunnerModel({}, { reviewRunner: 'codex', model: 'opus' }),
    /Review runner 'codex' does not support model 'opus'/,
  );
  assert.deepEqual(
    resolveReviewRunnerModel({ runner: 'claude', model: 'opus' }, { reviewRunner: 'codex' }),
    { reviewRunner: 'codex', model: 'gpt-6.1-sol' },
  );
});

test('disabled project review does not skip explicit publication reviews', () => {
  assert.equal(shouldSkipForDisabledReviewConfig({ enabled: false }), true);
  assert.equal(
    shouldSkipForDisabledReviewConfig({ enabled: false }, { publicationReview: true }),
    false,
  );
  assert.equal(shouldSkipForDisabledReviewConfig({ enabled: true }), false);
});

// ─── runReviewRetryLoop ───
//
// The loop's central invariant: it keeps `review → fix → re-review` going up to maxRetries
// times, then stops. Each fix pass must clear and re-baseline the signal so a long worker
// run on retry N+1 isn't capped by retry N's leftover timeout. Tests inject a deps mock
// to drive scripted scenarios.

const ISSUES: ReviewIssue[] = [{ file: 'a.ts', line: 1, description: 'x' }];

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
  modes: Array<string | undefined>;
  reviewEfforts: Array<string | null | undefined>;
  progressDetails: string[];
}

function buildDeps(opts: ScriptedDepsOptions): { deps: ReviewRetryDeps; calls: CallLog } {
  const calls: CallLog = {
    sendFeedback: 0,
    reviewAgent: 0,
    relaunches: 0,
    markStatus: [],
    feedbackBaselines: [],
    fixBaseShas: [],
    waitBaselines: [],
    artifactScopes: [],
    modes: [],
    reviewEfforts: [],
    progressDetails: [],
  };
  let reviewIdx = 0;
  let signalIdx = 0;
  const deps: ReviewRetryDeps = {
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
          artifactPaths: [`artifacts/pipeline-review-loop-${loopNumber}/fix-delta-stat.json`],
        };
      }
      return {
        snapshot: {
          source: 'local-git',
          capturedAt: new Date().toISOString(),
          fixBaseSha,
          fixHeadSha: `head-${loopNumber}`,
          diffPath: `artifacts/pipeline-review-loop-${loopNumber}/fix-delta.diff`,
          diffHash: `hash-${loopNumber}`,
          diffStat: {
            files: opts.fixDeltaFiles ?? 1,
            additions: opts.fixDeltaFiles === 0 ? 0 : 2,
            deletions: opts.fixDeltaFiles === 0 ? 0 : 1,
          },
        },
        artifactPaths: [
          `artifacts/pipeline-review-loop-${loopNumber}/fix-delta.diff`,
          `artifacts/pipeline-review-loop-${loopNumber}/fix-delta-stat.json`,
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
      mode,
      effort,
    ) => {
      calls.artifactScopes.push(artifactScope);
      calls.modes.push(mode);
      calls.reviewEfforts.push(effort);
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
            role: 'review-fix',
            status: 'working',
            taskFile: 'tasks/foo/REVIEW-FIX.md',
            signalFile: 'tasks/foo/REVIEW-FIX-SIGNAL.json',
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
  validationDepth: 'static-code' as const,
};

test('runReviewRetryLoop: incomplete re-review surfaces as skipped, not a false pass', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: ['incomplete'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runReviewRetryLoop({
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

test('resolveReviewMaxRetries keeps extra-review on the project cap', () => {
  assert.equal(
    resolveReviewMaxRetries({
      publicationReview: true,
      configuredMaxRetries: 3,
      requestedMaxRetries: 5,
      priorRetryCount: 6,
      resume: true,
    }),
    3,
  );
  assert.equal(
    resolveReviewMaxRetries({
      publicationReview: false,
      configuredMaxRetries: 3,
      priorRetryCount: 3,
      resume: true,
    }),
    4,
  );
});

test('runReviewRetryLoop: exhausts retries when every re-review still finds issues', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues', 'issues', 'issues'],
    fixSignals: [
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runReviewRetryLoop({
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
  assert.equal(result.recoveryContinuationPending, false);
  assert.equal(calls.sendFeedback, 3, 'three fix passes sent (one per retry slot)');
  assert.equal(
    calls.reviewAgent,
    3,
    're-review runs after every fix pass; the maxRetries gate trips on the next while-check, after pass 3',
  );
});

test('runReviewRetryLoop: a reserved Send back pass spends its persisted charge once, even at the cap', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  let delivered = 0;
  const result = await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: { verdict: 'issues', issues: ISSUES } satisfies ReviewAgentResult,
    // The reservation already raised the persisted count to the cap.
    retryCount: 2,
    reservedFixPass: { onDelivered: () => (delivered += 1) },
    deps,
  });
  assert.equal(calls.sendFeedback, 1, 'the reserved pass is delivered although the cap is reached');
  assert.equal(delivered, 1);
  assert.equal(result.retryCount, 2, 'no second increment for the reserved pass');
  assert.equal(calls.reviewAgent, 1, 'the repair is re-reviewed; no unreserved pass follows');
});

test('runReviewRetryLoop: a deferred reserved delivery is acknowledged only by its own fix signal', async () => {
  const run = async (fixSignals: WorkerSignal[]) => {
    const { deps } = buildDeps({
      reviewVerdicts: ['pass'],
      feedbackErrors: [new ReviewFixDeliveryError('unacknowledged retained handoff')],
      fixSignals,
    });
    deps.resumeFixPromptDelivery = async () => ({ status: 'deferred' });
    let delivered = 0;
    const result = await runReviewRetryLoop({
      ...baseArgs,
      maxRetries: 1,
      reviewResult: { verdict: 'issues', issues: ISSUES } satisfies ReviewAgentResult,
      retryCount: 1,
      reservedFixPass: { onDelivered: () => (delivered += 1) },
      deps,
    });
    return { delivered, result };
  };
  const acknowledged = await run([{ status: 'complete', timestamp: new Date().toISOString() }]);
  assert.equal(acknowledged.delivered, 1, 'the fix signal proves the repair reached the worker');
  assert.equal(acknowledged.result.retryCount, 1, 'still one charge');
  const unacknowledged = await run([]);
  assert.equal(unacknowledged.delivered, 0, 'no signal leaves the repair retryable');
  assert.equal(unacknowledged.result.retryCount, 1);
});

test('runReviewRetryLoop: later passes after a reserved Send back spend the normal budget', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues', 'pass'],
    fixSignals: [
      { status: 'complete', timestamp: new Date().toISOString() },
      { status: 'complete', timestamp: new Date().toISOString() },
    ],
  });
  const result = await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: { verdict: 'issues', issues: ISSUES } satisfies ReviewAgentResult,
    retryCount: 1,
    reservedFixPass: {},
    deps,
  });
  assert.equal(calls.sendFeedback, 2);
  assert.equal(result.retryCount, 2, 'only the unreserved pass increments');
  assert.equal(result.verdict, 'pass');
});

test('runReviewRetryLoop: a failed mid-loop relaunch drops a prior generation feedbackSent', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    workerAlive: false,
    relaunchOk: false,
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: a failed high-context relaunch drops a prior generation feedbackSent', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    contextPct: 95,
    relaunchOk: false,
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: stops as soon as a re-review verdict is pass', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runReviewRetryLoop({
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
  assert.equal(
    result.attempts?.[1]?.fixDelta?.diffPath,
    'artifacts/pipeline-review-loop-2/fix-delta.diff',
  );
});

test('runReviewRetryLoop: rethrows non-delivery failures from worker feedback', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: [],
    feedbackError: 'retired worker pane',
  });

  await assert.rejects(
    runReviewRetryLoop({
      ...baseArgs,
      maxRetries: 1,
      reviewResult: { verdict: 'issues', issues: ISSUES },
      retryCount: 0,
      deps,
    }),
    /retired worker pane/,
  );
});

test('runReviewRetryLoop: relaunches once when the retained worker rejects fix delivery', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    feedbackErrors: [new ReviewFixDeliveryError('unacknowledged retained handoff')],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runReviewRetryLoop({
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

test(
  'runReviewRetryLoop: deferred fresh-worker delivery waits for the fix signal before re-review',
  { timeout: 1_000 },
  async () => {
    const { deps, calls } = buildDeps({
      reviewVerdicts: ['pass'],
      feedbackErrors: [new ReviewFixDeliveryError('unacknowledged retained handoff')],
    });
    const statuses: string[] = [];
    let completeFix!: (signal: WorkerSignal) => void;
    const signal = new Promise<WorkerSignal>((resolve) => {
      completeFix = resolve;
    });
    let watching!: () => void;
    const watchStarted = new Promise<void>((resolve) => {
      watching = resolve;
    });
    let watcherStopped = false;
    deps.resumeFixPromptDelivery = async () => ({ status: 'deferred' });
    deps.setRunStatus = (_runId, status) => statuses.push(status);
    deps.startProgressWatcher = () => ({
      stop: () => {
        watcherStopped = true;
      },
    });
    deps.waitForWorkerSignal = async (_vars, _taskDir, _timeout, baseline, turnActive) => {
      assert.equal(baseline, '');
      assert.equal(turnActive, undefined, 'uncertain delivery cannot claim an accepted turn');
      watching();
      return signal;
    };
    const review = runReviewRetryLoop({
      ...baseArgs,
      maxRetries: 1,
      reviewResult: { verdict: 'issues', issues: ISSUES },
      retryCount: 0,
      deps,
    });
    await watchStarted;
    assert.deepEqual(statuses, ['reconciling']);
    assert.match(calls.progressDetails[0] ?? '', /delivery unconfirmed.*REVIEW-FIX-SIGNAL/);
    assert.equal(watcherStopped, false);
    assert.equal(calls.reviewAgent, 0);
    assert.equal(calls.relaunches, 1);
    assert.equal(calls.sendFeedback, 1);
    completeFix({ status: 'complete', timestamp: new Date().toISOString() });
    const result = await review;
    assert.equal(result.verdict, 'pass');
    assert.equal(result.retryCount, 1);
    assert.equal(calls.reviewAgent, 1);
    assert.equal(watcherStopped, true);
  },
);

test('runReviewRetryLoop: relaunches a high-context worker before sending the fix task', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues', 'pass'],
    contextPct: 93,
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  const result = await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: await deps.runReviewAgent(
      fakeVars,
      'claude',
      'sonnet',
      't',
      's',
      'r',
      1,
      1,
      'static-code',
    ),
    retryCount: 0,
    deps,
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(calls.relaunches, 1); // worker alive but saturated → fresh session first
  assert.equal(calls.sendFeedback, 1);
});

test('runReviewRetryLoop: low-context and unknown-context workers are not relaunched', async () => {
  for (const contextPct of [40, null]) {
    const { deps, calls } = buildDeps({
      reviewVerdicts: ['issues', 'pass'],
      contextPct,
      fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
    });
    const result = await runReviewRetryLoop({
      ...baseArgs,
      maxRetries: 2,
      reviewResult: await deps.runReviewAgent(
        fakeVars,
        'claude',
        'sonnet',
        't',
        's',
        'r',
        1,
        1,
        'static-code',
      ),
      retryCount: 0,
      deps,
    });
    assert.equal(result.verdict, 'pass');
    assert.equal(calls.relaunches, 0);
  }
});

test('runReviewRetryLoop: failed high-context relaunch skips feedback instead of sending into a wedged session', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['issues'],
    contextPct: 95,
    relaunchOk: false,
  });
  const result = await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 2,
    reviewResult: await deps.runReviewAgent(
      fakeVars,
      'claude',
      'sonnet',
      't',
      's',
      'r',
      1,
      1,
      'static-code',
    ),
    retryCount: 0,
    deps,
  });
  assert.equal(result.verdict, 'issues');
  assert.equal(calls.relaunches, 1);
  assert.equal(calls.sendFeedback, 0);
});

test('runReviewRetryLoop: continues after a fix-signal timeout when budget remains', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'], // second iteration's re-review passes
    fixSignals: [
      undefined, // first iteration times out
      { status: 'complete', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: returns blocked without re-review when a blocked fix changed nothing', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    fixDeltaFiles: 0,
    fixSignals: [
      { status: 'blocked', reason: 'pre-flight blocker', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: re-reviews partial changes before preserving a worker blocker', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [
      { status: 'blocked', reason: 'live recipe unavailable', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: an unreadable fix delta still forces the re-review', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixDeltaUnavailable: true,
    fixSignals: [
      { status: 'blocked', reason: 'slot lost its git index', timestamp: new Date().toISOString() },
    ],
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: bails when worker is dead and relaunch fails', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: [],
    workerAlive: false,
    relaunchOk: false,
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: maxRetries=0 short-circuits without sending feedback', async () => {
  const { deps, calls } = buildDeps({ reviewVerdicts: [] });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: forwards a fresh baseline to waitForWorkerSignal on every iteration', async () => {
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

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: seeded retryCount does not imply feedback was sent', async () => {
  const { deps, calls } = buildDeps({ reviewVerdicts: [] });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: resumed attempts keep history and advance artifact numbering', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  const priorAttempts = [
    { mode: 'cold' as const, loopNumber: 1, verdict: 'issues' as const, unresolvedCount: 1 },
    { mode: 'cold' as const, loopNumber: 2, verdict: 'issues' as const, unresolvedCount: 1 },
  ];

  const result = await runReviewRetryLoop({
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
  assert.equal(
    result.attempts?.[2]?.fixDelta?.diffPath,
    'artifacts/pipeline-review-loop-3/fix-delta.diff',
  );
});

test('runReviewRetryLoop: recovery path can mark prior feedback as already sent', async () => {
  // Mirrors recoverReviewFixPass: a fix pass already happened before we entered the loop.
  // If the seeded re-review verdict is `pass`, the loop should not iterate and retryCount stays at 1.
  const { deps, calls } = buildDeps({ reviewVerdicts: [] });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop: forwards artifactScope to fix deltas and re-review attempts', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    artifactScope: 'review-7',
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(calls.artifactScopes, ['review-7', 'review-7']);
});

test('runReviewRetryLoop: re-review launches with the loop effort', async () => {
  const { deps, calls } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runReviewRetryLoop({
    ...baseArgs,
    effort: 'low',
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps,
  });

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(calls.reviewEfforts, ['low']);
});

test('runReviewRetryLoop: records worker-fix timeline segment before re-review', async () => {
  const { deps } = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });

  const result = await runReviewRetryLoop({
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

test('runReviewRetryLoop threads mode into every re-review launch', async () => {
  // The retry loop is the code that actually relaunches reviewers, so it must
  // forward the resolved policy to runReviewAgent — and default to
  // warm-per-reviewer when the caller omits it — or re-reviews rebuild the
  // whole review from scratch after every worker fix.
  const warm = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    mode: 'warm',
    deps: warm.deps,
  });
  assert.deepEqual(warm.calls.modes, ['warm']);

  const dflt = buildDeps({
    reviewVerdicts: ['pass'],
    fixSignals: [{ status: 'complete', timestamp: new Date().toISOString() }],
  });
  await runReviewRetryLoop({
    ...baseArgs,
    maxRetries: 1,
    reviewResult: { verdict: 'issues', issues: ISSUES },
    retryCount: 0,
    deps: dflt.deps,
  });
  assert.deepEqual(dflt.calls.modes, ['cold']);
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

test('retryDeferredFixDelivery never rediscover or persist a pane after a possible send', async () => {
  const sends: string[] = [];
  const sendAttempted = true;
  let rediscoverCalls = 0;
  let persistCalls = 0;
  const result = await retryDeferredFixDelivery({
    runId: 'run-uncertain-send',
    target: 'coredev-1:dev',
    send: async (target) => {
      sends.push(target);
      return sends.length === 2;
    },
    rediscover: async () => {
      rediscoverCalls += 1;
      return { target: 'coredev-1:other', window: 'other', seenWindows: [] };
    },
    persistTarget: async () => {
      persistCalls += 1;
    },
    getRun: (() => ({ status: 'working' })) as any,
    isTargetBound: () => sendAttempted,
    retryIntervalMs: 1,
    retryWindowMs: 5_000,
  });
  assert.equal(result.sent, true);
  assert.deepEqual(sends, ['coredev-1:dev', 'coredev-1:dev']);
  assert.equal(rediscoverCalls, 0);
  assert.equal(persistCalls, 0);
});

test('retryDeferredFixDelivery pins the adopted pane once a retry may have sent', async () => {
  const sends: string[] = [];
  let sendAttempted = false;
  let rediscoverCalls = 0;
  const result = await retryDeferredFixDelivery({
    runId: 'run-mid-retry-send',
    target: 'coredev-1:dev',
    send: async (target) => {
      sends.push(target);
      sendAttempted = true;
      return sends.length === 2;
    },
    rediscover: async () => {
      rediscoverCalls += 1;
      return { target: `coredev-1:other-${rediscoverCalls}`, window: 'other', seenWindows: [] };
    },
    persistTarget: async () => {},
    getRun: (() => ({ status: 'working' })) as any,
    isTargetBound: () => sendAttempted,
    retryIntervalMs: 1,
    retryWindowMs: 5_000,
  });
  assert.equal(result.sent, true);
  assert.deepEqual(sends, ['coredev-1:other-1', 'coredev-1:other-1']);
  assert.equal(rediscoverCalls, 1);
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

test('a fix task waits for the worker turn to end instead of closing its window', async (t) => {
  // TAT-4006 7721a02b: grok ran an operator request for 26 min while review round 2 delivered its
  // fix. Delivery deferred 22 times, the window closed and the fix relaunch killed the turn.
  t.mock.method(console, 'warn', () => {});
  const run = makeRun({ status: 'reviewing' });
  const windowMs = 50;
  const turnEndsAt = Date.now() + 3 * windowMs;
  const turnActive = () => Date.now() < turnEndsAt;
  let busySends = 0;
  const result = await retryDeferredFixDelivery({
    runId: run.id,
    target: 'coredev-2:1.1',
    send: async () => {
      if (!turnActive()) return true;
      busySends += 1;
      return false;
    },
    rediscover: async () => ({ target: 'coredev-2:1.1', window: '1', seenWindows: [] }),
    persistTarget: async () => {},
    getRun: () => run,
    deferredReason: () =>
      'Live grok retained handoff was not accepted; refusing a destructive fresh-dispatch fallback',
    turnInProgress: async () => turnActive(),
    retryIntervalMs: 1,
    retryWindowMs: windowMs,
  });
  assert.equal(
    result.sent,
    true,
    `delivered at turn end, not dropped after ${busySends} busy sends`,
  );
  assert.ok(Date.now() >= turnEndsAt);
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
