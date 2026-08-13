import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperatorSnapshotResult, Run } from '@farmslot/protocol';

import { buildCopilotBootstrapBrief } from './bootstrap-brief.js';
import { testCheckout, testWorkload } from './test-helpers.js';

test('bootstrap brief includes every required projection and excludes secrets', () => {
  const operator = {
    generatedAt: '2026-08-12T00:00:00.000Z',
    sources: {},
    counts: {
      totalSlots: 1,
      readySlots: 0,
      busySlots: 1,
      heldSlots: 0,
      activeRuns: 1,
      queuedItems: 1,
      pendingDecisions: 1,
      recentEvents: 1,
    },
    fleet: {},
    machines: [],
    activeRuns: [],
    queue: [],
    pendingDecisions: [{ id: 'decision', type: 'test', title: 'Choose', actions: [] }],
    recentEvents: [],
  } as unknown as OperatorSnapshotResult;
  const run = {
    id: 'run-1',
    flowType: 'review-pr',
    status: 'working',
    prNumber: 42,
    reviewValidationDepth: 'full-live',
    steps: [
      { name: 'prepare', status: 'running' },
      { name: 'recipe', status: 'running' },
    ],
    agentContexts: [
      { role: 'review', status: 'working', slotId: 'slot-1', target: { target: 'pane' } },
      { role: 'self-review-fix', status: 'working', slotId: 'slot-1' },
      { role: 'ci-fix', status: 'waiting', slotId: 'slot-1' },
    ],
  } as unknown as Run;
  const brief = buildCopilotBootstrapBrief({
    generatedAt: '2026-08-12T00:00:00.000Z',
    runtime: {
      runner: 'cursor',
      model: 'test-model',
      safetyTier: 'sandboxed',
      tmuxTarget: 'farmslot-copilot:agent.0',
    },
    checkout: testCheckout('/operator/farmslot'),
    operator,
    screenEvidence: { surfaceId: 'fleet', text: 'visible screen' },
    observerEvidence: { events: [{ summary: 'observer event' }] },
    savedMemory: 'saved memory token=ghp_12345678901234567890',
    runs: [run],
    workload: testWorkload(true),
    backlog: { queue: [{ id: 'backlog-1' }] },
    roadmap: 'roadmap item 16',
    cadence: { watch: '30s' },
  });
  for (const heading of [
    'Current Command Center screen evidence',
    'Observer evidence',
    'Saved Co-Pilot memory',
    'Full agent-role inventory',
    'Pending decisions',
    'Backlog and dispatch queue',
    'Roadmap',
    'PR and independent-review state',
    'Recipe executions',
    'Prepare and dev-server activity',
    'Fleet and host workload pressure',
    'Checkout state',
    'Watch cadence',
    'Authority rules',
  ]) {
    assert.match(brief, new RegExp(`## ${heading}`));
  }
  assert.match(brief, /review-pr/);
  assert.match(brief, /self-review-fix/);
  assert.match(brief, /ci-fix/);
  assert.match(brief, /full-live/);
  assert.doesNotMatch(brief, /ghp_/);
  assert.match(brief, /\[REDACTED\]/);
});
