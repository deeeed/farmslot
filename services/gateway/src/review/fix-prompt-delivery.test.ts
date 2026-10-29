import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

const { resumeReviewFixPromptDelivery, reconcileRecoveredFixPromptDelivery } =
  await import('./orchestrator.js');

function fixture() {
  const context: AgentContext = {
    id: 'review-fix',
    label: 'Review fix',
    slotId: 'fixture',
    runId: 'run-1234',
    role: 'review-fix',
    status: 'working',
    runner: 'claude',
    model: 'sonnet',
    taskFile: 'tasks/case/REVIEW-FIX.md',
    signalFile: 'tasks/case/REVIEW-FIX-SIGNAL.json',
    attemptStartedAt: '2026-10-29T19:01:24.093Z',
    target: { session: 'fixture', window: 'dev', pane: null, target: 'fixture:dev' },
  };
  const run = makeRun({
    agentContexts: [context],
    metrics: { runner: 'claude', model: 'sonnet', nudgeCount: 0 },
  });
  const boundaries: Array<string | undefined> = [];
  const deps: NonNullable<Parameters<typeof resumeReviewFixPromptDelivery>[3]> = {
    getRun: () => run,
    resolvePrompt: async (_project, input) => `Read ${input.taskFile}`,
    resolveRuntimeDir: async () => '.agent',
    readLaunchAck: async () => null,
    syncChecklistTarget: async () => {},
    ensureTarget: async () => 'fixture:dev',
    persistTarget: async () => {},
    targetHostsRunner: async () => true,
    recordDeliveryBoundary: async (_id, _context, boundary) => {
      boundaries.push(boundary);
      context.promptDeliveryStartedAt = boundary;
    },
    deliver: async () => ({
      delivered: false,
      disposition: 'hold',
      retryable: true,
      reason: 'not ready',
      sendAttempted: false,
    }),
  };
  return {
    context,
    run,
    boundaries,
    deps,
    vars: makeVars({ slotId: 'fixture', remoteRepo: '/fixture' }),
  };
}

test('restart retries an unsent fix without treating its preparation as a prior send', async (t) => {
  const f = fixture();
  assert.equal(
    (await resumeReviewFixPromptDelivery(f.vars, f.run.id, f.context, f.deps)).status,
    'deferred',
  );
  assert.deepEqual(f.boundaries, [], 'readiness checks cannot record a send');
  assert.equal(f.context.promptDeliveryStartedAt, undefined);
  f.deps.deliver = async (options) => {
    assert.equal(options.priorPromptSendAttempted, false);
    await options.onPromptMutationStart?.();
    assert.equal(f.boundaries.length, 1, 'persist the boundary before typing');
    return { delivered: true, acknowledgement: 'structured', turnToken: 'fixture-turn' };
  };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const recovered = reconcileRecoveredFixPromptDelivery(f.vars, f.run.id, f.context, f.deps, {
    retryIntervalMs: 1,
    retryWindowMs: 100,
  });
  t.mock.timers.tick(1);
  assert.deepEqual(await recovered, { status: 'delivered', turnToken: 'fixture-turn' });
});

test('a proven untouched input clears its boundary so restart can deliver it', async () => {
  const f = fixture();
  f.deps.deliver = async (options) => {
    await options.onPromptMutationStart?.();
    assert.equal(typeof f.context.promptDeliveryStartedAt, 'string');
    await options.onPromptMutationConfirmedUntouched?.();
    return {
      delivered: false,
      disposition: 'hold',
      retryable: true,
      reason: 'host guard refused before input',
      sendAttempted: false,
    };
  };
  assert.equal(
    (await resumeReviewFixPromptDelivery(f.vars, f.run.id, f.context, f.deps)).status,
    'deferred',
  );
  assert.equal(f.boundaries.length, 2);
  assert.equal(f.context.promptDeliveryStartedAt, undefined);
});

test('a shell without the runner requests one relaunch instead of waiting for its fix signal', async () => {
  const f = fixture();
  f.deps.targetHostsRunner = async () => false;
  f.deps.deliver = async () => assert.fail('a shell must never receive the fix prompt');
  assert.deepEqual(await resumeReviewFixPromptDelivery(f.vars, f.run.id, f.context, f.deps), {
    status: 'relaunch-required',
  });
  assert.deepEqual(f.boundaries, []);
});
