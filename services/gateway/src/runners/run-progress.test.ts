import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, NativeSessionReadResult, Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { makeRun } from '../run-engine/test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');
const { readAgentContextProgress, readRunProgress, runDecisionWaitingStatus } =
  await import('./run-progress.js');

function fixRun(transport: 'native' | 'tmux', status: AgentContext['status'] = 'blocked'): Run {
  return {
    ...makeRun({ status: 'fixing' }),
    transport,
    steps: [{ name: 'dispatch', status: 'done' }],
    agentContexts: [
      {
        id: 'fix',
        role: 'review-fix',
        runId: 'run-1',
        slotId: 'slot-1',
        label: 'Fix',
        target: { target: '%owned', session: 'owned', paneId: '%owned' },
        runner: 'codex',
        status,
        nativeCommandId: 'command-1',
        promptDeliveryStartedAt: '2026-10-12T00:00:00.000Z',
        promptAcceptance: {
          deliveryStartedAt: '2026-10-12T00:00:00.000Z',
          turnToken: 'turn-1',
          runner: 'codex',
          sessionId: 'session-1',
          sessionPath: '/tmp/session-1',
          observedAt: 1,
        },
      },
    ],
  };
}

const slot = { slotId: 'slot-1', remoteRepo: '/tmp/owned' } as SlotVars;
const reading = <T>(value: T) => ({
  value,
  confidence: 'high' as const,
  source: 'hook' as const,
  observedAt: Date.now(),
});

for (const transport of ['native', 'tmux'] as const) {
  test(`${transport} terminal blocked fix preserves structured idle and waiting`, async () => {
    const run = fixRun(transport);
    for (const kind of ['idle', 'awaiting-input'] as const) {
      const progress = await readRunProgress(run, {
        native: async (_id, role) =>
          ({
            session: { state: role === 'review-fix' && kind !== 'idle' ? 'waiting' : 'idle' },
          }) as NativeSessionReadResult,
        nativeFixActive: async () => false,
        slot: async () => slot,
        target: async (_slot, selector) => ({
          target: selector?.role === 'review-fix' ? '%owned' : '%primary',
          session: 'owned',
        }),
        activity: async (_vars, target) => reading(target === '%owned' ? kind : 'idle'),
        turn: async () => reading('idle'),
        turnActive: async () => false,
      });
      assert.equal(progress.kind, kind);
    }
  });

  test(`${transport} fixing requires the exact accepted active turn`, async () => {
    const run = fixRun(transport, 'working');
    for (const active of [false, true]) {
      const progress = await readRunProgress(run, {
        native: async (_id, role) =>
          ({
            session: { state: role === 'review-fix' ? 'running' : 'idle' },
          }) as NativeSessionReadResult,
        nativeFixActive: async () => active,
        slot: async () => slot,
        target: async (_slot, selector) => ({
          target: selector?.role === 'review-fix' ? '%owned' : '%primary',
          session: 'owned',
        }),
        activity: async (_vars, target) => reading(target === '%owned' ? 'tool-running' : 'idle'),
        turn: async (_vars, target) => reading(target === '%owned' ? 'active' : 'idle'),
        turnActive: async (_vars, _target, _runner, token) => {
          assert.equal(token, 'turn-1');
          return active;
        },
      });
      assert.equal(progress.kind, active ? 'making-progress' : 'unproven');
      assert.equal(
        runDecisionWaitingStatus(run, progress, 'human_gate'),
        active ? 'fixing' : 'reconciling',
      );
    }
  });
}

test('pane-only progress cannot establish idle or fixing', async () => {
  const run = fixRun('tmux');
  const progress = await readRunProgress(run, {
    slot: async () => slot,
    target: async (_slot, selector) => ({
      target: selector?.role === 'review-fix' ? '%owned' : '%primary',
      session: 'owned',
    }),
    activity: async () => ({ ...reading('idle'), source: 'pane' }),
    turn: async () => null,
  });
  assert.equal(progress.kind, 'unproven');
});

test('a ready idle no-change gate waits for its operator', () => {
  const run = makeRun({ status: 'monitoring' });
  assert.equal(
    runDecisionWaitingStatus(run, { kind: 'idle' }, 'no_change', {
      state: 'ready',
      reasons: [],
      identity: { runId: run.id, generation: 0 },
    }),
    'human-gating',
  );
});

test('confirmed stopped native failure permits recovery; uncertain shutdown does not', async () => {
  const run = fixRun('native');
  for (const stopped of [false, true]) {
    const progress = await readRunProgress(run, {
      native: async () =>
        ({ session: { state: 'failed', processStopped: stopped } }) as NativeSessionReadResult,
    });
    assert.equal(progress.kind, stopped ? 'idle' : 'unproven');
    assert.equal(
      runDecisionWaitingStatus(run, progress, 'native-worker-recovery'),
      stopped ? 'blocked' : 'reconciling',
    );
  }
});

test('the owned primary worker keeps progressing between turns while its background job runs', async () => {
  const run = fixRun('tmux');
  const context: AgentContext = {
    ...run.agentContexts![0],
    id: 'primary',
    role: 'primary',
    runner: 'claude',
  };
  for (const background of ['active', 'idle', 'unknown'] as const) {
    const progress = await readAgentContextProgress(run, context, {
      slot: async () => slot,
      target: async () => ({ target: '%owned', session: 'owned' }),
      taskProgress: async () => null,
      activity: async () => reading('idle'),
      turn: async () => reading('idle'),
      background: async () => reading(background),
    });
    assert.equal(
      progress.kind,
      background === 'active' ? 'making-progress' : background === 'idle' ? 'idle' : 'unproven',
    );
    assert.equal(
      runDecisionWaitingStatus(run, progress, 'interactive_handoff'),
      background === 'active' ? 'monitoring' : background === 'idle' ? 'blocked' : 'reconciling',
    );
  }
});
