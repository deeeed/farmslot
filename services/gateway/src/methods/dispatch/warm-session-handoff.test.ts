import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  resolveWarmWorkerBinding,
  warmHandoffFailureFromRetainedDelivery,
} from './warm-session-handoff.js';

function run(overrides: Partial<Run>): Pick<Run, 'flowType' | 'agentContexts'> {
  return {
    flowType: overrides.flowType ?? 'dev',
    agentContexts: overrides.agentContexts ?? [],
  };
}

test('resolveWarmWorkerBinding uses the parent worker after slot flow metadata moves', () => {
  const binding = resolveWarmWorkerBinding(
    'mme-2',
    run({
      flowType: 'dev',
      agentContexts: [
        {
          id: 'dev',
          role: 'dev',
          label: 'Dev',
          status: 'complete',
          runId: 'parent',
          slotId: 'mini-mme-2',
          target: {
            session: 'mme-2',
            window: 'dev',
            pane: '0',
            target: 'mme-2:dev.0',
          },
          startedAt: '2026-07-31T00:00:00.000Z',
          updatedAt: '2026-07-31T00:00:00.000Z',
        },
      ],
    }),
    'pr-complete',
    'pr-complete',
  );

  assert.equal(binding.role, 'dev');
  assert.equal(binding.target, 'mme-2:dev.0');
});

test('resolveWarmWorkerBinding rejects a persisted target from another session', () => {
  const binding = resolveWarmWorkerBinding(
    'mme-2',
    run({
      flowType: 'fix-bug',
      agentContexts: [
        {
          id: 'fix-bug',
          role: 'fix-bug',
          label: 'Bugfix',
          status: 'complete',
          runId: 'parent',
          slotId: 'mini-mme-2',
          target: {
            session: 'old-session',
            window: 'bugfix',
            pane: '0',
            target: 'old-session:bugfix.0',
          },
          startedAt: '2026-07-31T00:00:00.000Z',
          updatedAt: '2026-07-31T00:00:00.000Z',
        },
      ],
    }),
    null,
    'pr-complete',
  );

  assert.equal(binding.role, 'fix-bug');
  assert.equal(binding.target, null);
});

test('resolveWarmWorkerBinding falls back to canonical primary role without a parent', () => {
  const binding = resolveWarmWorkerBinding('mme-2', null, 'pr-complete', 'pr-complete');
  assert.equal(binding.role, 'primary');
  assert.equal(binding.target, null);
});

test('warm handoff holds a live worker when retained delivery permits only in-place fallback', () => {
  assert.deepEqual(
    warmHandoffFailureFromRetainedDelivery({
      delivered: false,
      disposition: 'safe-send',
      reason: 'retained session state is unknown',
    }),
    {
      handedOff: false,
      disposition: 'hold',
      reason: 'retained session state is unknown',
    },
  );
});
