import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import { renderPipelineControls } from './run-pipeline-panels.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: 'TAT-4145',
    slotId: 'slot-1',
    branch: 'feat/tat-4145',
    taskFile: '/tmp/TASK.md',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

const handlers = { pause: () => undefined, resume: () => undefined, cancel: () => undefined };

test('a run held for a result decision offers no Cancel: Close on the decision ends it', () => {
  assert.match(litText(renderPipelineControls(makeRun(), handlers)), />\s*Cancel\s*</);
  assert.doesNotMatch(
    litText(renderPipelineControls(makeRun({ status: 'needs-decision' }), handlers)),
    /Cancel/,
  );
});
