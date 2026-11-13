import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ProjectVars } from '../core/config.js';
import type { NativeSessionUsageRequest } from '../runners/native-session-usage-command.js';
import { makeVars } from '../runners/test-fixtures.js';

await import('./mock-pty.test-support.js');
const config = await import('../core/config.js');
const projectJson: ProjectVars['projectJson'] = {
  command_env: {
    unset: ['LITELLM_URL', 'LITELLM_BASE_URL', 'LITELLM_API_KEY'],
    domains: { trading: { set: { RECIPE_LIBRARY_PATH: 'trading={{trading_library_repo}}' } } },
  },
};
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadMachinePool: async () => ({ env: {} }),
    loadSlotVars: async () => {
      throw new Error('A slotless native review must not look up a slot');
    },
    loadProjectVars: async () => ({ projectName: 'fixture', projectJson }),
  },
});
const requests: NativeSessionUsageRequest[] = [];
const ownership = await import('../security/native-worker-owner.js');
mock.module('../security/native-worker-owner.js', {
  namedExports: { ...ownership, resolveReviewWorkspaceOwner: () => 'owner' },
});
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv: async (owner: string, node: string, argv: string[]) => {
      assert.equal(owner, 'owner');
      assert.equal(node, 'review-node');
      requests.push(...JSON.parse(argv.at(-2)!));
      // Only the node transport is substituted. Execute the production transcript program.
      return promisify(execFile)(process.execPath, [
        ...argv.slice(1, -1),
        path.resolve(import.meta.dirname, '../../../../packages/slot-config/src/session-usage.ts'),
      ]);
    },
  },
});
const { createRun, updateRun, getRun, deleteRun } = await import('../runs/store.js');
const { upsertAgentContext } = await import('../agents/contexts.js');
const { captureRunSessionUsage } = await import('./agent-session-usage.js');

test('slotless native review persists cold and resumed run receipts through frozen launch bindings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-static-review-usage-'));
  const run = createRun(
    {
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: 'owner/repo#1',
      transport: 'native',
      reviewWorkspaceTarget: { machine: 'review-node' },
    },
    { nativeOwnerPrincipalId: 'owner' },
  );
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled', agentContexts: [], reviewWorkspace: undefined });
    await deleteRun(run.id);
    await rm(root, { recursive: true, force: true });
  });
  const stateDirectory = path.join(root, 'workers/owner/host');
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(path.join(root, 'sessions'));
  const journal = path.join(root, 'sessions/host.journal');
  const submission = (leaseId: string, commandId: string, at: string) =>
    JSON.stringify({
      commands: [{ leaseId, commandId }],
      event: { type: 'command.submitted', commandId, at },
    }) + '\n';
  await writeFile(
    journal,
    JSON.stringify({
      info: {
        id: 'host',
        nativeSessionId: 'native-review',
        ownerPrincipalId: 'owner',
        executionNodeId: 'review-node',
        runner: 'pi',
        cwd: root,
      },
    }) +
      '\n' +
      submission('lease', 'command', '2026-11-10T14:00:00Z'),
  );
  const transcript = path.join(root, 'pi-session.jsonl');
  await writeFile(
    transcript,
    [
      { type: 'session', id: 'native-review', cwd: root },
      {
        type: 'message',
        id: 'answer',
        timestamp: '2026-11-10T14:05:00Z',
        message: {
          role: 'assistant',
          model: 'fixture-model',
          usage: { input: 200, output: 40, cacheRead: 160, cost: { total: 0.002 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  updateRun(run.id, {
    createdAt: '2026-11-10T14:00:00Z',
    domain: 'trading',
    metrics: { ...run.metrics, runner: 'pi', model: 'fixture-model' },
    reviewWorkspaceTarget: { machine: 'review-node' },
    reviewWorkspace: {
      workspaceId: 'fixture',
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: root,
      taskPath: path.join(root, 'task'),
      artifactPath: path.join(root, 'task/artifacts'),
      support: {
        path: path.join(root, 'support'),
        sha256: 'a'.repeat(64),
        sources: [],
        skills: [],
        environment: { RECIPE_LIBRARY_PATH: 'trading={{support}}/libraries/trading' },
      },
    },
  });
  // The production context writer enforces that native contexts cannot have tmux targets.
  await upsertAgentContext(run.id, 'review', {
    id: 'review',
    runner: 'pi',
    runnerSessionId: 'native-review',
    runnerSessionPath: transcript,
    effort: 'high',
    status: 'complete',
    startedAt: '2026-11-10T14:00:00Z',
    completedAt: '2026-11-10T14:10:00Z',
    nativeSession: {
      sessionId: 'host',
      stateDirectory,
      ownerPrincipalId: 'owner',
      executionNodeId: 'review-node',
      leaseId: 'lease',
      commandId: 'command',
      releasedAt: '2026-11-10T14:10:00Z',
    },
  });
  await captureRunSessionUsage(run.id);
  const result = getRun(run.id)!;
  assert.equal(result.agentContexts![0].target, undefined);
  assert.equal(result.sessionUsage![0].source, 'runner-transcript', result.sessionUsage![0].error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].cwd, root);
  assert.deepEqual(requests[0].usageWindow, {
    startedAt: '2026-11-10T14:00:00Z',
    completedAt: '2026-11-10T14:10:00Z',
    nativeLeaseIds: ['lease'],
  });
  assert.equal(result.sessionUsage![0].scope, 'run-delta');
  assert.equal(result.sessionUsage![0].totalTokens, 400);
  assert.equal(result.sessionUsage![0].costUsd, 0.002);

  updateRun(run.id, { status: 'done' });
  const warm = createRun(
    {
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: 'owner/repo#1',
      transport: 'native',
      reviewWorkspaceTarget: { machine: 'review-node' },
    },
    { nativeOwnerPrincipalId: 'owner' },
  );
  t.after(async () => {
    updateRun(warm.id, { status: 'cancelled', agentContexts: [], reviewWorkspace: undefined });
    await deleteRun(warm.id);
  });
  updateRun(warm.id, {
    // A queued successor can be created before its predecessor finishes.
    createdAt: '2026-11-09T14:00:00Z',
    metrics: result.metrics,
    reviewWorkspace: result.reviewWorkspace,
  });
  await appendFile(journal, submission('warm-lease', 'warm-command', '2026-11-11T14:00:00Z'));
  const message = {
    type: 'message',
    id: 'warm-answer',
    timestamp: '2026-11-11T14:05:00Z',
    message: {
      role: 'assistant',
      model: 'fixture-model',
      usage: { input: 20, output: 4, cacheRead: 16, cost: { total: 0.0002 } },
    },
  };
  await appendFile(
    transcript,
    [message, message].map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  await upsertAgentContext(warm.id, 'review', {
    id: 'review',
    runner: 'pi',
    runnerSessionId: 'native-review',
    runnerSessionPath: transcript,
    effort: 'high',
    status: 'complete',
    startedAt: '2026-11-11T14:00:00Z',
    completedAt: '2026-11-11T14:10:00Z',
    nativeSession: {
      sessionId: 'host',
      stateDirectory,
      ownerPrincipalId: 'owner',
      executionNodeId: 'review-node',
      leaseId: 'warm-lease',
      commandId: 'warm-command',
      launchRequestedAt: '2026-11-11T14:00:00Z',
      releasedAt: '2026-11-11T14:10:00Z',
    },
  });
  await captureRunSessionUsage(warm.id);
  await captureRunSessionUsage(warm.id);
  const receipt = getRun(warm.id)!.sessionUsage![0];
  assert.equal(receipt.scope, 'run-delta');
  assert.equal(receipt.turns, 1);
  assert.equal(receipt.totalTokens, 40);
  assert.equal(receipt.costUsd, 0.0002);
  assert.equal(requests.length, 2, 'A settled receipt is measured once');
  const { piSessionUsageProvider } = await import('../runners/session-usage-provider.js');
  const { extractRunWorkerSessionUsage } = await import('./session-usage.js');
  t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [
    {
      contextId: 'review',
      runnerSessionId: 'native-review',
      runnerSessionPath: transcript,
    },
  ]);
  const completionUsage = await extractRunWorkerSessionUsage(
    { ...getRun(warm.id)!, slotId: 'fixture-slot' },
    makeVars(),
  );
  assert.equal(completionUsage?.scope, 'run-delta');
  assert.equal(completionUsage?.totalTokens, 40, 'Completion recovery preserves the run window');
  assert.equal(completionUsage?.costUsd, 0.0002);
  updateRun(warm.id, {
    repeatReviewContext: {
      version: 1,
      chainId: 'fixture-chain',
      generation: 2,
      priorRunId: run.id,
      priorFamilyId: run.id,
      repository: 'owner/repo',
      prNumber: 1,
      currentHeadSha: 'b'.repeat(40),
      verdict: 'issues',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode: 'warm',
      validationDepth: 'static-code',
      session: {
        mode: 'warm',
        continuity: 'resumed',
        priorRunId: run.id,
        sessionId: 'native-review',
      },
    },
  });
  await captureRunSessionUsage(warm.id);
  assert.equal(getRun(warm.id)!.metrics.sessionTotalTokens, 40);
  assert.equal(getRun(warm.id)!.metrics.costEstimate, 0.0002);
  assert.equal(getRun(warm.id)!.metrics.sessionUsageScope, 'review-generation-delta');
});
