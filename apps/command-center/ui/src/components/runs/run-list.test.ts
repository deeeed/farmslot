import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  inventoryShowsBackAffordance,
  inventoryShowsDetail,
  inventoryShowsList,
} from '../shared/work-inventory-table.js';

import {
  compactRunPipelineLabel,
  isHumanPublicationGateLabel,
  isIndependentReviewLabel,
} from './run-list-inventory.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'fam-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'human-gating',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-1',
    slotId: 'mini-ff-2',
    branch: null,
    taskFile: null,
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 0 },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T01:00:00.000Z',
    agentContexts: [],
    ...overrides,
  } as Run;
}

test('active independent review is not displayed as a human publication gate', () => {
  const reviewing = run({
    agentContexts: [
      {
        role: 'self-review',
        status: 'working',
        runner: 'claude',
        model: 'opus',
      } as NonNullable<Run['agentContexts']>[number],
    ],
  });
  const label = compactRunPipelineLabel(reviewing);
  assert.equal(isIndependentReviewLabel(label), true);
  assert.equal(isHumanPublicationGateLabel(label), false);
  assert.notEqual(label.toLowerCase(), 'operator gate');
  assert.notEqual(label.toLowerCase(), 'human-gating');
  assert.match(label, /independent review/i);
});

test('human-gating without active review keeps an operator-gate honesty label', () => {
  const label = compactRunPipelineLabel(run());
  assert.equal(isIndependentReviewLabel(label), false);
  assert.ok(
    label === 'operator gate' || label === 'publish ready' || label === 'review blocked',
    `unexpected gate label: ${label}`,
  );
});

test('independent review fix loop stays distinct from publication gate', () => {
  const label = compactRunPipelineLabel(
    run({
      agentContexts: [
        {
          role: 'self-review-fix',
          status: 'working',
        } as NonNullable<Run['agentContexts']>[number],
      ],
    }),
  );
  assert.equal(label, 'Independent review fix');
  assert.equal(isHumanPublicationGateLabel(label), false);
});

test('operator-held completion replaces the raw running monitor label', () => {
  const label = compactRunPipelineLabel(
    run({
      flowType: 'dev',
      mode: 'interactive',
      status: 'paused',
      steps: [
        {
          name: 'monitor',
          status: 'running',
          outputs: {
            awaitingOperator: true,
            reason: 'interactive-completion-operator-owned',
          },
        },
      ],
    }),
  );
  assert.equal(label, 'awaiting operator action');
});

test('run inventory selection uses split detail on wide screens and back on narrow screens', () => {
  const wide = { hasSelection: true, narrowViewport: false, forceList: false };
  assert.equal(inventoryShowsList(wide), true);
  assert.equal(inventoryShowsDetail(wide), true);
  assert.equal(inventoryShowsBackAffordance(wide), false);

  const narrow = { ...wide, narrowViewport: true };
  assert.equal(inventoryShowsList(narrow), false);
  assert.equal(inventoryShowsDetail(narrow), true);
  assert.equal(inventoryShowsBackAffordance(narrow), true);
});
