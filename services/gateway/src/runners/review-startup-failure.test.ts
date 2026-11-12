import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { RunnerPromptAcceptance } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type { ObservabilityReading, RunnerSessionDeliveryState } from './observability-types.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'review-runner-failure-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
mkdirSync(path.join(root, 'pool'));
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: 'fixture',
    platform: 'cli',
    slots: [],
  }),
);
after(() => rmSync(root, { recursive: true, force: true }));
const { createRun, updateRun } = await import('../runs/store.js');
const { observeReviewRunnerFailure } = await import('./review-startup.js');
const { getRunnerObservability } = await import('./registry.js');
const observer = getRunnerObservability('pi');
assert.ok(observer);
const since = 1_800_000_000_000;
const created = createRun({
  project: 'fixture',
  ticketOrPr: 'example/app#1',
  flowType: 'review-pr',
  mode: 'autonomous',
  runner: 'pi',
  transport: 'tmux',
});
const run = updateRun(created.id, {
  reviewWorkspace: {
    workspaceId: 'fixture',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: root,
    taskPath: root,
    artifactPath: root,
  },
  agentContexts: [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      status: 'working',
      slotId: null,
      runId: 'fixture',
      runner: 'pi',
      target: { session: 'fixture', target: 'fixture' },
      promptDeliveryStartedAt: new Date(since).toISOString(),
    },
  ],
});
const failure = 'Pi model request timed out after 300000ms and one retry';
const reading: ObservabilityReading<RunnerSessionDeliveryState> = {
  value: 'idle',
  source: 'hook',
  confidence: 'high',
  observedAt: since + 600_000,
  sessionId: 'session',
  turnToken: `session:${since + 1}`,
  failure,
};

test('a digest-hook reviewer fails on its current input, without a native acceptance API or task mark', async (t) => {
  const original = observer.getTurnState;
  const getTurnState = t.mock.fn(async () => reading);
  observer.getTurnState = getTurnState;
  t.after(() => {
    observer.getTurnState = original;
  });
  assert.equal(await observeReviewRunnerFailure(run, null), failure);
  for (const patch of [
    { turnToken: `session:${since - 1}` },
    { turnToken: undefined },
    { observedAt: since - 1 },
    { source: 'pane' as const },
    { confidence: 'low' as const },
    { failureKind: 'transport' as const },
    { failure: undefined },
  ]) {
    getTurnState.mock.mockImplementation(async () => ({ ...reading, ...patch }));
    assert.equal(await observeReviewRunnerFailure(run, null), null, JSON.stringify(patch));
  }
});

test('a native acceptance restricts the failure to its exact session and turn', async (t) => {
  const acceptance: RunnerPromptAcceptance = {
    runner: 'pi',
    deliveryStartedAt: new Date(since).toISOString(),
    sessionId: 'session',
    sessionPath: '/fixture/session.jsonl',
    observedAt: since + 1,
    turnToken: reading.turnToken,
  };
  t.mock.method(observer, 'getSessionDeliveryState', async () => reading);
  assert.equal(await observeReviewRunnerFailure(run, acceptance), failure);
  for (const patch of [
    { turnToken: 'session:old-turn' },
    { sessionId: 'other-session' },
    { source: 'unknown' as const },
    { failureKind: 'transport' as const },
  ]) {
    t.mock.method(observer, 'getSessionDeliveryState', async () => ({ ...reading, ...patch }));
    assert.equal(await observeReviewRunnerFailure(run, acceptance), null);
  }
});
