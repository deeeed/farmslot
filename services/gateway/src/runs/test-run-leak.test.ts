import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { isLeakedGatewayTestFixture, isLeakedGatewayTestRun } from './test-run-leak.js';

function minimalRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-id',
    familyId: 'run-id',
    parentRunId: null,
    familyRootTicketOrPr: 'PROJ-1',
    lane: 'production',
    variant: null,
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'created',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

test('isLeakedGatewayTestRun detects evidence selection fixture ticket', () => {
  assert.equal(
    isLeakedGatewayTestRun(minimalRun({ ticketOrPr: 'EVIDENCE-SELECTION-ABC123' })),
    true,
  );
});

test('isLeakedGatewayTestRun detects publish drift fixture ticket', () => {
  assert.equal(
    isLeakedGatewayTestRun(minimalRun({ ticketOrPr: 'PUBLISH-DRIFT-19F18DBCB68' })),
    true,
  );
});

test('isLeakedGatewayTestRun detects evidence drift fixture ticket', () => {
  assert.equal(isLeakedGatewayTestRun(minimalRun({ ticketOrPr: 'EVIDENCE-DRIFT-ABC123' })), true);
});

test('isLeakedGatewayTestRun detects temp task dir from drift tests', () => {
  assert.equal(
    isLeakedGatewayTestRun(
      minimalRun({
        ticketOrPr: 'PROJ-99',
        taskFile: '/var/folders/xx/farmslot-package-drift-AbCdEf/task.md',
      }),
    ),
    true,
  );
});

test('isLeakedGatewayTestRun detects publish-gate drift decision id', () => {
  assert.equal(
    isLeakedGatewayTestRun(
      minimalRun({
        ticketOrPr: 'PROJ-99',
        decisions: [
          {
            id: 'publish-gate-drift',
            type: 'engine_human_gate',
            title: 'Ready',
            description: 'Ready',
            actions: [],
            createdAt: '2026-04-15T00:00:00.000Z',
          },
        ],
      }),
    ),
    true,
  );
});

test('isLeakedGatewayTestRun detects evidence selection task dir and decision id', () => {
  assert.equal(
    isLeakedGatewayTestRun(
      minimalRun({
        ticketOrPr: 'PROJ-99',
        taskFile: '/var/folders/xx/farmslot-evidence-selection-AbCdEf/task.md',
        decisions: [
          {
            id: 'publish-gate-evidence-selection',
            type: 'engine_human_gate',
            title: 'Ready',
            description: 'Ready',
            actions: [],
            createdAt: '2026-04-15T00:00:00.000Z',
          },
        ],
      }),
    ),
    true,
  );
});

test('isLeakedGatewayTestRun detects exercise initialContext', () => {
  assert.equal(
    isLeakedGatewayTestRun(
      minimalRun({
        ticketOrPr: 'PROJ-99',
        engineState: {
          interactiveDev: {
            initialContext: 'Exercise current package drift approval',
          },
        },
      }),
    ),
    true,
  );
});

test('isLeakedGatewayTestRun ignores real runs', () => {
  assert.equal(
    isLeakedGatewayTestRun(
      minimalRun({
        ticketOrPr: 'MM-1234',
        slotId: 'macwork-ff-1',
        taskFile: '/Users/me/farmslot/projects/mm/tasks/TASK-123/task.md',
        metrics: {
          nudgeCount: 0,
          model: 'gpt-5',
          runner: 'codex',
          runnerSessionId: null,
          runnerSessionPath: null,
        },
      }),
    ),
    false,
  );
});

test('isLeakedGatewayTestFixture detects create params before persist', () => {
  assert.equal(
    isLeakedGatewayTestFixture({
      ticketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
      initialContext: 'Exercise current package drift approval',
    }),
    true,
  );
  assert.equal(
    isLeakedGatewayTestFixture({
      ticketOrPr: 'MM-4321',
    }),
    false,
  );
});
