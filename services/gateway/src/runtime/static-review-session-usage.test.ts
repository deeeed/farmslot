import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

await import('./mock-pty.test-support.js');
let remote = false;
let remoteCommand = '';
// Set by the LiteLLM test: its fixture node holds LiteLLM turns, priced only from bound prices.
let liteLlmTurns = false;
let launchMutation: { unset: string[]; set: Record<string, string> } = { unset: [], set: {} };
mock.module('../runners/review-workspace-context.js', {
  namedExports: {
    reviewWorkspaceRunnerVars: async () =>
      makeVars(remote ? { host: 'review.invalid', machine: 'review-node' } : {}),
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (vars: { host: string }, command: string) => {
      assert.equal(vars.host, 'review.invalid');
      assert.match(command, /runSessionUsage/);
      assert.match(command, /pi-session\.jsonl/);
      remoteCommand = command;
      const unpriced = liteLlmTurns && !command.includes('"liteLlmRoute"');
      return {
        exitCode: 0,
        stderr: '',
        stdout:
          'turns=2\nmodel=glm-5p3-flash\ninput_tokens=200\noutput_tokens=40\ncache_read=160\ncache_creation=0\ntotal_tokens=400\n' +
          (unpriced
            ? 'cost_reason=No verified model price for all used token categories\n'
            : 'cost_usd=0.002\n'),
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
    reviewEnvironment: async () => launchMutation,
  },
});
const { createRun, updateRun, getRun, deleteRun } = await import('../runs/store.js');
const { piSessionUsageProvider } = await import('../runners/session-usage-provider.js');
const { captureRunSessionUsage } = await import('./agent-session-usage.js');
const { liteLlmEndpointId } = await import('@farmslot/agent-runtime/scripts/litellm-endpoint.cjs');

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

test("a warm static tmux review keeps its session unsplit by the new review's marks", async (t) => {
  remote = false;
  const root = await mkdtemp(path.join(os.tmpdir(), 'static-review-usage-warm-'));
  const run = createRun({
    flowType: 'review-pr',
    project: 'usage-fixture',
    ticketOrPr: 'owner/repo#1',
  });
  t.after(async () => {
    updateRun(run.id, {
      status: 'cancelled',
      slotId: null,
      reviewWorkspace: { ...getRun(run.id)!.reviewWorkspace!, cleanedAt: new Date().toISOString() },
    });
    await deleteRun(run.id);
    await rm(root, { recursive: true, force: true });
  });
  const transcript = path.join(root, 'pi-session.jsonl');
  const reply = (timestamp: string) => ({
    type: 'message',
    id: `entry-${timestamp}`,
    timestamp,
    message: {
      role: 'assistant',
      model: 'glm-5p3-flash',
      usage: { input: 100, output: 20, cacheRead: 80, cost: { total: 0.001 } },
    },
  });
  await writeFile(
    transcript,
    [
      { type: 'session', id: 'pi-session', timestamp: '2026-11-10T13:00:00Z', cwd: root },
      // The earlier review of the previous head, in the conversation this attempt resumed.
      reply('2026-11-10T13:05:00Z'),
      reply('2026-11-10T13:06:00Z'),
      reply('2026-11-10T14:05:00Z'),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [
    { contextId: 'review', runnerSessionId: 'pi-session', runnerSessionPath: transcript },
  ]);
  const repeatReviewContext = {
    mode: 'warm',
    session: { priorSessionId: 'pi-session' },
  } as NonNullable<Run['repeatReviewContext']>;
  updateRun(run.id, {
    reviewWorkspaceTarget: { machine: 'localhost' },
    transport: 'tmux',
    repeatReviewContext,
    metrics: {
      ...run.metrics,
      runner: 'pi',
      model: 'litellm/glm-5p3-flash',
      checklistTiming: {
        schemaVersion: 1,
        source: 'CHECKLIST.md',
        events: [{ stepNumber: 1, label: '1. Review', checkedAt: '2026-11-10T14:06:00Z' }],
      },
    },
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
        status: 'complete',
        startedAt: '2026-11-10T14:00:00Z',
        attemptStartedAt: '2026-11-10T14:00:00Z',
        completedAt: '2026-11-10T14:10:00Z',
        target: { session: 'review-fixture', target: 'review-fixture' },
      },
    ],
  });
  await captureRunSessionUsage(run.id);
  const receipt = getRun(run.id)!.sessionUsage![0];
  // The resumed transcript holds the earlier review's replies; none is charged to step 1.
  assert.equal(receipt.toolUsage?.stepsUnavailable, 'The session has no checklist marks');
  assert.deepEqual(receipt.toolUsage?.steps, []);
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

for (const gateway of ['priced', 'no-prices'] as const)
  test(`a remote static Pi review sends its launch endpoint's bound prices (${gateway})`, async (t) => {
    remote = true;
    remoteCommand = '';
    liteLlmTurns = true;
    const root = await mkdtemp(path.join(os.tmpdir(), 'static-review-launch-pricing-'));
    const run = createRun({
      flowType: 'review-pr',
      project: 'usage-fixture',
      ticketOrPr: 'owner/repo#1',
    });
    t.after(async () => {
      liteLlmTurns = false;
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
    const endpoint = 'https://litellm-review.example';
    const apiKey = 'review-test-key';
    await writeFile(
      path.join(
        root,
        `${createHash('sha256').update(`${endpoint}\n${apiKey}`).digest('hex')}-direct.json`,
      ),
      JSON.stringify({
        fetchedAt: Date.now(),
        data: [
          {
            model_name: 'glm-5p3-flash',
            model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
          },
        ],
      }),
    );
    // Production wiring: the reviewer's launch mutation as review-tmux resolves it.
    launchMutation = {
      unset: gateway === 'priced' ? [] : ['LITELLM_URL', 'LITELLM_BASE_URL'],
      set:
        gateway === 'priced'
          ? {
              LITELLM_BASE_URL: endpoint,
              LITELLM_API_KEY: apiKey,
              FARMSLOT_LITELLM_PRICING_CACHE_DIR: root,
            }
          : {},
    };
    const transcript = '/review-node/pi-session.jsonl';
    t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [
      { contextId: 'review', runnerSessionId: 'pi-session', runnerSessionPath: transcript },
    ]);
    updateRun(run.id, {
      reviewWorkspaceTarget: { machine: 'review-node' },
      transport: 'tmux',
      metrics: { ...run.metrics, runner: 'pi', model: 'litellm/glm-5p3-flash' },
      reviewWorkspace: {
        workspaceId: 'review-fixture',
        machine: 'review-node',
        executionNodeId: 'review-node',
        checkoutPath: '/review-node/source',
        taskPath: '/review-node/task',
        artifactPath: '/review-node/task/artifacts',
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
          status: 'complete',
          startedAt: '2026-11-10T14:00:00Z',
          completedAt: '2026-11-10T14:10:00Z',
          target: { session: 'review-fixture', target: 'review-fixture' },
          runnerSessionId: 'pi-session',
          runnerSessionPath: transcript,
        },
      ],
    });
    // A cost from an earlier measurement of this receipt.
    updateRun(run.id, { metrics: { ...getRun(run.id)!.metrics, costEstimate: 0.5 } });
    await captureRunSessionUsage(run.id);
    const receipt = getRun(run.id)!.sessionUsage![0];
    // Always the empty list: a node without route binding never quotes from its own lookup.
    assert.equal(remoteCommand.includes('"liteLlmPrices":[]'), true);
    assert.equal(
      remoteCommand.includes(
        `"liteLlmRoute":{"endpointId":"${liteLlmEndpointId(`${endpoint}/v1`)}","prices":[["glm-5p3-flash"`,
      ),
      gateway === 'priced',
    );
    assert.equal(receipt.totalTokens, 400);
    const unpriced = gateway === 'no-prices';
    assert.equal(receipt.costUsd, unpriced ? null : 0.002);
    assert.equal(receipt.costStatus, unpriced ? 'unpriced' : 'estimated');
    // The run total follows the receipt: an unpriced receipt leaves no earlier cost behind.
    const metrics = getRun(run.id)!.metrics;
    assert.equal(metrics.sessionTotalTokens, 400);
    assert.equal(metrics.costEstimate, unpriced ? undefined : 0.002);
  });

test('unavailable native Pi usage keeps its earlier cost estimate', async () => {
  const { makeRun } = await import('../run-completion/test-fixtures.js');
  const { workspaceUsageMetrics } = await import('./session-usage-result.js');
  const run = makeRun({ flowType: 'review-pr', transport: 'native' });
  run.metrics.costEstimate = 0.5;
  run.reviewWorkspace = {
    workspaceId: 'native-review',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/review/source',
    taskPath: '/review/task',
    artifactPath: '/review/task/artifacts',
  };
  run.agentContexts = [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      status: 'complete',
      runId: run.id,
      slotId: null,
      runner: 'pi',
      runnerSessionId: 'native-review',
    },
  ];
  run.sessionUsage = [
    {
      runner: 'pi',
      runnerSessionId: 'native-review',
      measuredAt: '2026-11-20T00:00:00.000Z',
      source: 'unavailable',
      costStatus: 'unpriced',
      error: 'Native session is unavailable',
    },
  ];
  assert.equal(workspaceUsageMetrics(run).costEstimate, 0.5);
});
