import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { RunnerSessionArchiveRef } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';
import { piSessionUsageProvider } from '../runners/session-usage-provider.js';
import { makeVars } from '../runners/test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'pi-worker-archive-'));
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_HOME = path.join(root, 'home');
after(() => rm(root, { recursive: true, force: true }));
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async (slotId: string) =>
      makeVars(slotId === 'remote-slot' ? { host: 'offline.invalid', machine: 'remote' } : {}),
  },
});
const { projectArchivedRunnerUsage } = await import('./session-usage.js');
const { runnerSessionArchiveContextDir } = await import('../runners/session-archive.js');

test('Pi reads preserve stored totals or a verified archive after the native file is removed', async (t) => {
  const run = makeRun({ flowType: 'dev', slotId: 'test-slot' });
  const originalPath = path.join(root, 'original.jsonl');
  const raw =
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        model: 'test-model',
        usage: {
          input: 314,
          output: 137552,
          cacheRead: 36878019,
          cacheWrite: 1020272,
          cost: { total: 22.6048636 },
        },
      },
    }) + '\n';
  await writeFile(originalPath, raw);
  const archiveDir = runnerSessionArchiveContextDir(run.id, 'dev');
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(archiveDir, 'transcript.jsonl'), raw);
  const ref: RunnerSessionArchiveRef = {
    status: 'captured',
    kind: 'jsonl',
    runner: 'pi',
    originalPath,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
  run.metrics = { ...run.metrics, runner: 'pi', runnerSessionArchive: ref };
  run.agentContexts = [
    {
      id: 'dev',
      role: 'dev',
      label: 'Dev',
      status: 'complete',
      slotId: run.slotId,
      runId: run.id,
      runner: 'pi',
      runnerSessionArchive: ref,
    },
  ];
  await rm(originalPath);
  const recovery = t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [
    {
      contextId: 'dev',
      runnerSessionId: 'worker',
      runnerSessionPath: originalPath,
    },
  ]);
  const stored = await projectArchivedRunnerUsage({
    ...run,
    metrics: {
      ...run.metrics,
      sessionTotalTokens: 50999041,
      sessionTurns: 297,
      costEstimate: 31.8,
    },
  });
  assert.equal(stored.metrics.sessionTotalTokens, 50999041);
  assert.equal(stored.metrics.costEstimate, 31.8);
  assert.match(stored.metrics.sessionUsageError ?? '', /unavailable|ENOENT/);
  const archived = await projectArchivedRunnerUsage(run);
  assert.equal(archived.metrics.sessionTotalTokens, 38036157);
  assert.equal(archived.metrics.costEstimate, 22.6048636);
  assert.match(archived.metrics.sessionUsageError ?? '', /unavailable|ENOENT/);
  recovery.mock.mockImplementation(async () => {
    throw new Error('node offline');
  });
  const offline = await projectArchivedRunnerUsage(run);
  assert.equal(offline.metrics.sessionTotalTokens, 38036157);
  assert.equal(offline.metrics.costEstimate, 22.6048636);
  assert.equal(offline.metrics.sessionUsageError, 'node offline');
  assert.equal(run.metrics.sessionTotalTokens, undefined, 'projection remains read-only');
});

test('archived tmux Pi usage preserves local pricing and the remote provider subtotal', async (t) => {
  const cacheDir = path.join(root, 'prices');
  const endpoint = 'https://pricing.example';
  const apiKey = 'fixture-key';
  t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => {
    throw new Error('node offline');
  });
  const priorEnv = process.env;
  process.env = {
    ...priorEnv,
    LITELLM_URL: endpoint,
    LITELLM_API_KEY: apiKey,
    FARMSLOT_LITELLM_PRICING_CACHE_DIR: cacheDir,
  };
  t.after(() => {
    process.env = priorEnv;
  });
  await mkdir(cacheDir, { recursive: true });
  const cacheKey = createHash('sha256').update(`${endpoint}\n${apiKey}`).digest('hex');
  await writeFile(
    path.join(cacheDir, `${cacheKey}.json`),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: [{ model_name: 'glm', model_info: { input_cost_per_token: 0.00001 } }],
    }),
  );
  const raw =
    [
      { input: 1000, output: 0, cost: { total: 0 } },
      { input: 100, output: 0, cost: { total: 0.0042, totalFromProvider: true } },
    ]
      .map((usage) =>
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            provider: 'litellm',
            model: 'glm',
            stopReason: 'stop',
            usage,
          },
        }),
      )
      .join('\n') + '\n';
  for (const kind of ['local-review', 'local-slot', 'remote-slot'] as const) {
    const localReview = kind === 'local-review';
    const role = localReview ? 'review' : 'dev';
    const run = makeRun({
      id: kind,
      flowType: localReview ? 'review-pr' : 'dev',
      slotId: localReview ? null : kind,
      transport: 'tmux',
    });
    if (localReview)
      run.reviewWorkspace = {
        workspaceId: kind,
        machine: 'localhost',
        executionNodeId: 'local',
        checkoutPath: '/review/source',
        taskPath: '/review/task',
        artifactPath: '/review/task/artifacts',
      };
    const archiveDir = runnerSessionArchiveContextDir(run.id, role);
    await mkdir(archiveDir, { recursive: true });
    await writeFile(path.join(archiveDir, 'transcript.jsonl'), raw);
    const ref: RunnerSessionArchiveRef = {
      status: 'captured',
      kind: 'jsonl',
      runner: 'pi',
      originalPath: '/execution/pi-session.jsonl',
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    run.metrics = { ...run.metrics, runner: 'pi', runnerSessionArchive: ref };
    run.agentContexts = [
      {
        id: role,
        role,
        label: role,
        status: 'complete',
        slotId: run.slotId,
        runId: run.id,
        runner: 'pi',
        runnerSessionArchive: ref,
      },
    ];
    const projected = await projectArchivedRunnerUsage(run);
    assert.equal(projected.metrics.sessionTotalTokens, 1100, kind);
    assert.equal(projected.metrics.costEstimate, kind === 'remote-slot' ? undefined : 0.0142, kind);
    assert.equal(
      projected.metrics.sessionProviderReportedCostUsd,
      kind === 'remote-slot' ? 0.0042 : undefined,
      kind,
    );
  }
});
