import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { makeVars } from '../runners/test-fixtures.js';

import type { NativeAgentUsageInput } from './native-session-usage.js';

await import('./mock-pty.test-support.js');
let remote = false;
mock.module('../runners/review-workspace-context.js', {
  namedExports: {
    reviewWorkspaceRunnerVars: async () =>
      makeVars(remote ? { host: 'review.invalid', machine: 'review-node' } : {}),
  },
});
const nativeRequests: NativeAgentUsageInput[] = [];
mock.module('./native-session-usage.js', {
  namedExports: {
    extractNativeAgentSessionUsage: async (input: NativeAgentUsageInput) => {
      nativeRequests.push(input);
      return {
        runner: input.runner,
        runnerSessionId: input.runnerSessionId,
        source: 'runner-transcript',
        measuredAt: '2026-11-10T14:10:00Z',
        totalTokens: 400,
        costUsd: 0.002,
      };
    },
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (vars: { host: string }, command: string) => {
      assert.equal(vars.host, 'review.invalid');
      assert.match(command, /runSessionUsage/);
      assert.match(command, /pi-session.jsonl/);
      return {
        exitCode: 0,
        stderr: '',
        stdout:
          'turns=2\nmodel=glm-5p3-flash\ninput_tokens=200\noutput_tokens=40\ncache_read=160\ncache_creation=0\ntotal_tokens=400\ncost_usd=0.002\n',
      };
    },
  },
});
mock.module('../runners/review-tmux.js', {
  namedExports: {
    REVIEW_STARTUP_TIMEOUT_MS: 300000,
    reviewTmuxStartupState: () => 'acknowledged',
    recoverReviewTmuxSession: async () => {},
    verifiedWarmReviewSessionId: () => undefined,
    reviewTmuxSession: () => 'review-fixture',
    reviewTmuxOperation: async () => ({ stopped: true }),
    launchReviewTmux: async () => ({}),
  },
});
const { createRun, updateRun, getRun, deleteRun } = await import('../runs/store.js');
const { piSessionUsageProvider } = await import('../runners/session-usage-provider.js');
const { captureRunSessionUsage } = await import('./agent-session-usage.js');

for (const target of ['local', 'remote'])
  test(`a ${target} slotless static review captures its exact Pi session and cost once`, async (t) => {
    remote = target === 'remote';
    const root = await mkdtemp(path.join(os.tmpdir(), 'static-review-usage-'));
    const run = createRun({
      flowType: 'review-pr',
      project: 'usage-fixture',
      ticketOrPr: 'owner/repo#1',
    });
    t.after(async () => {
      updateRun(run.id, {
        status: 'cancelled',
        slotId: null,
        reviewWorkspace: {
          ...getRun(run.id)!.reviewWorkspace!,
          cleanedAt: new Date().toISOString(),
        },
      });
      await deleteRun(run.id);
      await rm(root, { recursive: true, force: true });
    });
    const transcript = path.join(root, 'pi-session.jsonl');
    await writeFile(
      transcript,
      [
        { type: 'session', id: 'pi-session', timestamp: '2026-11-10T14:00:00Z', cwd: root },
        ...[1, 2].map(() => ({
          type: 'message',
          message: {
            role: 'assistant',
            model: 'glm-5p3-flash',
            usage: { input: 100, output: 20, cacheRead: 80, cost: { total: 0.001 } },
          },
        })),
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [
      { contextId: 'review', runnerSessionId: 'pi-session', runnerSessionPath: transcript },
    ]);
    updateRun(run.id, {
      reviewWorkspaceTarget: { machine: 'localhost' },
      transport: 'tmux',
      metrics: { ...run.metrics, runner: 'pi', model: 'litellm/glm-5p3-flash' },
      reviewWorkspace: {
        workspaceId: 'review-fixture',
        machine: 'localhost',
        executionNodeId: 'local',
        checkoutPath: root,
        taskPath: path.join(root, 'task'),
        artifactPath: path.join(root, 'task/artifacts'),
      },
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          runId: run.id,
          slotId: null,
          runner: 'pi',
          model: 'litellm/glm-5p3-flash',
          effort: 'high',
          status: remote ? 'complete' : 'failed',
          startedAt: '2026-11-10T14:00:00Z',
          completedAt: '2026-11-10T14:10:00Z',
          target: { session: 'review-fixture', target: 'review-fixture' },
        },
      ],
    });
    if (remote) {
      await captureRunSessionUsage(run.id);
    } else {
      // The run-store can settle the context before teardown reaches accounting.
      const { teardownReviewWorkspace } = await import('../review-workspaces/pipeline.js');
      await teardownReviewWorkspace(run.id);
    }
    await captureRunSessionUsage(run.id);
    const result = getRun(run.id)!;
    assert.equal(result.agentContexts![0].runnerSessionId, 'pi-session');
    assert.equal(result.sessionUsage!.length, 1);
    const receipt = result.sessionUsage![0];
    assert.equal(receipt.totalTokens, 400);
    assert.equal(receipt.costUsd, 0.002);
    assert.equal(receipt.role, 'review');
    assert.equal(receipt.flowType, 'review-pr');
    assert.equal(receipt.costStatus, 'estimated');
    assert.equal(receipt.durationMs, 600_000);
    assert.equal(result.metrics.runnerSessionId, 'pi-session');
    assert.equal(result.metrics.sessionTotalTokens, 400);
    assert.equal(result.metrics.costEstimate, 0.002);
  });

test('ambiguous workspace sessions stay unbound', async (t) => {
  const { recoverWorkspaceUsageBindings } = await import('../runners/session-usage-recovery.js');
  const { makeRun } = await import('../run-completion/test-fixtures.js');
  const base = makeRun({ flowType: 'review-pr' });
  const run = {
    ...base,
    transport: 'tmux' as const,
    reviewWorkspace: {
      workspaceId: 'fixture',
      machine: 'fixture',
      executionNodeId: 'local',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review' as const,
        label: 'Review',
        runId: base.id,
        slotId: null,
        runner: 'pi',
        status: 'failed' as const,
      },
    ],
  };
  t.mock.method(piSessionUsageProvider, 'recoverSessions', async () =>
    ['first', 'second'].map((id) => ({
      contextId: 'review',
      runnerSessionId: id,
      runnerSessionPath: `/owned/${id}.jsonl`,
    })),
  );
  assert.equal(await recoverWorkspaceUsageBindings(run), run);
});

test('native slotless review usage keeps its workspace context and run domain for expansion', async (t) => {
  remote = true;
  const run = createRun({
    flowType: 'review-pr',
    project: 'usage-fixture',
    ticketOrPr: 'owner/repo#1',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled', slotId: null, reviewWorkspace: undefined });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    domain: 'trading',
    reviewWorkspace: {
      workspaceId: 'review-fixture',
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/artifacts',
    },
    sessionUsage: [
      {
        role: 'review',
        runner: 'pi',
        runnerSessionId: 'native-review',
        source: 'unavailable',
        measuredAt: '2026-11-10T14:00:00Z',
        nativeSession: {
          sessionId: 'host',
          ownerPrincipalId: 'owner',
          executionNodeId: 'review-node',
        },
      },
    ],
  });
  const before = nativeRequests.length;
  await captureRunSessionUsage(run.id);
  assert.equal(nativeRequests.length, before + 1);
  assert.deepEqual(
    nativeRequests.at(-1)?.vars,
    makeVars({ host: 'review.invalid', machine: 'review-node', domain: 'trading' }),
  );
  assert.equal(getRun(run.id)?.sessionUsage?.[0]?.totalTokens, 400);
  assert.equal(getRun(run.id)?.sessionUsage?.[0]?.costUsd, 0.002);
});
