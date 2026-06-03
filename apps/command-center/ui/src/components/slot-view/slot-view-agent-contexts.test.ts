import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContextSummary } from '@farmslot/protocol';

import {
  agentContextKey,
  deriveSlotViewAgentContexts,
  isAgentContextUnavailable,
  selectSlotViewAgentContext,
  type SlotViewAgentContextRun,
  type SlotViewAgentContextSlot,
} from './slot-view-agent-contexts.js';

function context(overrides: Partial<AgentContextSummary> = {}): AgentContextSummary {
  return {
    id: overrides.id ?? 'primary',
    role: overrides.role ?? 'primary',
    label: overrides.label ?? 'Primary',
    status: overrides.status ?? 'working',
    target: overrides.target ?? { session: 'session-1', pane: '0', target: 'pane-1' },
    ...overrides,
  };
}

function run(overrides: Partial<SlotViewAgentContextRun> = {}): SlotViewAgentContextRun {
  return {
    id: 'run-1',
    flowType: 'fix-bug',
    status: 'monitoring',
    taskFile: '/tmp/TASK.md',
    metrics: { nudgeCount: 0, model: 'opus', runner: 'claude' },
    ...overrides,
  };
}

function slot(overrides: Partial<SlotViewAgentContextSlot> = {}): SlotViewAgentContextSlot {
  return {
    currentFlowType: 'fix-bug',
    ...overrides,
  };
}

test('deriveSlotViewAgentContexts filters stale slot contexts and prefers run contexts', () => {
  const contexts = deriveSlotViewAgentContexts({
    linkedRun: run({
      agentContexts: [context({ id: 'fix', role: 'fix-bug', label: 'Fix', runId: 'run-1' })],
    }),
    slot: slot({
      agentContexts: [
        context({ id: 'old', role: 'primary', runId: 'other-run' }),
        context({ id: 'fix', role: 'fix-bug', label: 'Slot Mirror', runId: 'run-1' }),
      ],
    }),
  });

  assert.deepEqual(
    contexts.map((ctx) => ctx.id),
    ['fix'],
  );
  assert.equal(contexts[0].label, 'Fix');
});

test('deriveSlotViewAgentContexts falls back to flow role when no concrete contexts exist', () => {
  const contexts = deriveSlotViewAgentContexts({
    linkedRun: run({ agentContexts: [] }),
    slot: slot(),
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].role, 'fix-bug');
  assert.equal(contexts[0].status, 'working');
});

test('selectSlotViewAgentContext and unavailable checks are deterministic', () => {
  const contexts = [
    context({ id: 'primary', role: 'primary' }),
    context({ id: 'review', role: 'review' }),
  ];

  assert.equal(selectSlotViewAgentContext(contexts, 'review')?.id, 'review');
  assert.equal(selectSlotViewAgentContext(contexts, 'missing')?.id, 'primary');
  assert.equal(agentContextKey(contexts[0]), 'primary');
  assert.equal(isAgentContextUnavailable(contexts[0], new Set(['primary'])), true);
});
