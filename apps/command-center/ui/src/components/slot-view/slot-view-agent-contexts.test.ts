import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContextSummary } from '@farmslot/protocol';

import {
  agentContextKey,
  deriveSlotViewAgentContexts,
  isAgentContextUnavailable,
  selectSlotViewAgentContext,
  selectSlotViewTaskContext,
  slotViewAgentContextChipLabel,
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

test('selectSlotViewAgentContext opens latest or specific reviewer tabs', () => {
  const contexts = [
    context({
      id: 'fix-bug',
      role: 'fix-bug',
      label: 'Bugfix',
      target: { session: 's', window: 'bugfix', target: 's:bugfix' },
    }),
    context({
      id: 'rev-codex',
      role: 'self-review',
      label: 'Self-review',
      updatedAt: '2026-07-09T12:01:00Z',
      model: 'gpt-5',
      target: { session: 's', window: 'rev-codex', target: 's:rev-codex' },
    }),
    context({
      id: 'rev-claude',
      role: 'self-review',
      label: 'Self-review',
      updatedAt: '2026-07-09T12:02:00Z',
      model: 'opus',
      target: { session: 's', window: 'rev-claude', target: 's:rev-claude' },
    }),
  ];

  assert.equal(selectSlotViewAgentContext(contexts, 'rev-codex')?.id, 'rev-codex');
  assert.equal(selectSlotViewAgentContext(contexts, 'latest-reviewer')?.id, 'rev-claude');
  assert.equal(selectSlotViewAgentContext(contexts, 'self-review')?.id, 'rev-claude');
  assert.equal(slotViewAgentContextChipLabel(contexts[1]), 'rev-codex');
});

test('deriveSlotViewAgentContexts keeps multiple reviewer tabs for one run', () => {
  const contexts = deriveSlotViewAgentContexts({
    linkedRun: run({
      agentContexts: [
        context({
          id: 'fix-bug',
          role: 'fix-bug',
          label: 'Bugfix',
          runId: 'run-1',
          target: { session: 's', window: 'bugfix', target: 's:bugfix' },
        }),
        context({
          id: 'rev-codex',
          role: 'self-review',
          label: 'Self-review',
          runId: 'run-1',
          target: { session: 's', window: 'rev-codex', target: 's:rev-codex' },
        }),
        context({
          id: 'rev-claude',
          role: 'self-review',
          label: 'Self-review',
          runId: 'run-1',
          target: { session: 's', window: 'rev-claude', target: 's:rev-claude' },
        }),
      ],
    }),
    slot: slot(),
  });

  assert.deepEqual(
    contexts.map((ctx) => ctx.id),
    ['fix-bug', 'rev-claude', 'rev-codex'],
  );
});

test('selectSlotViewTaskContext joins canonical prepared and worker task roots', () => {
  const contexts = [
    context({
      id: 'primary',
      role: 'primary',
      taskFile: '.sandbox/farmslot-farm/worker-task/review/547-0814-135435/TASK.md',
    }),
    context({
      id: 'review',
      role: 'self-review',
      taskFile: '.sandbox/farmslot-farm/worker-task/review/547-0814-135435/SELF-REVIEW.md',
    }),
  ];

  assert.equal(
    selectSlotViewTaskContext(
      contexts,
      'review-pr',
      '/Users/deeeed/dev/farmslot/.sandbox/farmslot-farm/tasks/review/547-0814-135435/TASK.md',
    )?.id,
    'primary',
  );
});

test('selectSlotViewTaskContext does not join arbitrary suffix-only paths', () => {
  const contexts = [
    context({ id: 'review', role: 'self-review', taskFile: '/tmp/review/547/TASK.md' }),
    context({ id: 'primary', role: 'primary', taskFile: '/tmp/primary/TASK.md' }),
  ];

  assert.equal(
    selectSlotViewTaskContext(contexts, 'review-pr', '/another/root/review/547/TASK.md')?.id,
    'primary',
  );
});

test('selectSlotViewTaskContext uses gateway identity for configured task roots', () => {
  const contexts = [
    context({
      id: 'review',
      role: 'self-review',
      taskFile: '/worker/custom-root/review/547/SELF-REVIEW.md',
      taskIdentity: '547/SELF-REVIEW.md',
    }),
    context({ id: 'primary', role: 'primary', taskFile: '/worker/custom-root/review/547/TASK.md' }),
  ];

  assert.equal(
    selectSlotViewTaskContext(
      contexts,
      'review-pr',
      '/prepared/different-root/review/547/SELF-REVIEW.md',
    )?.id,
    'review',
  );
});
