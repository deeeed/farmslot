import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countToolUsage } from '@farmslot/agent-runtime/tool-usage';
import type { AgentContext } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';

import { contextChecklistMarks, receiptChecklistMarks } from './session-usage.js';

const T = Date.parse('2026-11-18T07:00:00Z');
const at = (seconds: number) => new Date(T + seconds * 1000).toISOString();
const context: AgentContext = {
  id: 'review',
  role: 'review',
  label: 'Review',
  runId: 'run',
  slotId: null,
  status: 'complete',
  attemptStartedAt: at(0),
};

function reviewRun() {
  const run = makeRun({ flowType: 'review-pr' });
  run.metrics = {
    ...run.metrics,
    checklistTiming: {
      schemaVersion: 1,
      source: 'CHECKLIST.md',
      events: [
        { stepNumber: 1, label: '1. Run the shared checklist', checkedAt: at(60) },
        { stepNumber: 2, label: '2. Complete the review', checkedAt: at(120) },
      ],
    },
    subtasks: [
      {
        id: 'perps-shared',
        parent: { checklist: 'CHECKLIST.md', stepNumber: 1 },
        source: { kind: 'skill', sha256: 'aa', renderedSha256: 'bb' },
        status: 'complete',
        durationMs: 40_000,
        completedSteps: 2,
        totalSteps: 2,
        checklistTiming: {
          schemaVersion: 1,
          source: 'perps-shared.md',
          events: [
            // An earlier attempt's mark is not this session's boundary.
            { stepNumber: 1, label: 'Record the review context', checkedAt: at(-30) },
            { stepNumber: 1, label: 'Record the review context', checkedAt: at(20) },
            { stepNumber: 2, label: 'Check the order flow', checkedAt: at(40) },
          ],
        },
      },
      {
        id: 'other-checklist-child',
        parent: { checklist: 'OTHER.md', stepNumber: 1 },
        source: { kind: 'skill', sha256: 'cc', renderedSha256: 'dd' },
        status: 'complete',
        durationMs: 1000,
        completedSteps: 1,
        totalSteps: 1,
        checklistTiming: {
          schemaVersion: 1,
          events: [{ stepNumber: 1, label: 'Not under CHECKLIST.md', checkedAt: at(50) }],
        },
      },
    ],
  };
  return run;
}

test('a measured session splits a parent step by the rows of the child checklist it ran', () => {
  const run = reviewRun();
  const usage = countToolUsage(
    {
      tools: [10, 30, 50, 100].map((seconds) => ({ name: 'bash', issuedAt: at(seconds) })),
      tokens: null,
      compactions: null,
    },
    receiptChecklistMarks(run, context),
  );
  assert.deepEqual(
    usage.steps
      .filter((step) => step.segment !== 'after-last-mark')
      .map((step) => [step.stepNumber, step.title, step.toolCalls]),
    [
      [1, 'perps-shared 1. Record the review context', 1],
      [1, 'perps-shared 2. Check the order flow', 1],
      [1, '1. Run the shared checklist', 1],
      [2, '2. Complete the review', 1],
    ],
  );
});

test('live progress keeps the parent marks only', () => {
  assert.deepEqual(
    contextChecklistMarks(reviewRun(), context).map((mark) => mark.label),
    ['1. Run the shared checklist', '2. Complete the review'],
  );
});
