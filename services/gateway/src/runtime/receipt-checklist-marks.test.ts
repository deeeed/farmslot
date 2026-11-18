import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countToolUsage } from '@farmslot/agent-runtime/tool-usage';
import type { AgentContext } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';

import {
  contextChecklistMarks,
  RECEIPT_CHILD_MARK_LIMIT,
  RECEIPT_CHILD_TITLE_CHARS,
  receiptChecklistMarks,
} from './session-usage.js';

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

test('a child closed with --mark-last ends its parent step on its own last row', () => {
  const run = reviewRun();
  const child = run.metrics.subtasks![0];
  // The last row and the parent step share one timestamp, as `sub complete --mark-last` writes them.
  child.checklistTiming!.events.push({
    stepNumber: 3,
    label: '3. Confirm the verdict',
    checkedAt: at(60),
  });
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
      // A numbered label keeps its own number once.
      [1, 'perps-shared 3. Confirm the verdict', 1],
      [2, '2. Complete the review', 1],
    ],
  );
});

test("rows marked in one millisecond, and a step closing as the next step's row is marked, keep one boundary each in step order", () => {
  const run = reviewRun();
  const child = run.metrics.subtasks![0];
  child.checklistTiming!.events.push(
    { stepNumber: 3, label: '3) Confirm the verdict', checkedAt: at(44) },
    { stepNumber: 4, label: 'Record the evidence', checkedAt: at(45) },
    { stepNumber: 5, label: 'Record the evidence again', checkedAt: at(45) },
  );
  run.metrics.subtasks!.push({
    ...child,
    id: 'perps-client',
    parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
    checklistTiming: {
      schemaVersion: 1,
      events: [{ stepNumber: 1, label: 'Check the client', checkedAt: at(60) }],
    },
  });
  const marks = receiptChecklistMarks(run, context);
  assert.deepEqual(
    marks.map((mark) => [mark.stepNumber, mark.label, (Date.parse(mark.checkedAt) - T) / 1000]),
    [
      [1, 'perps-shared 1. Record the review context', 20],
      [1, 'perps-shared 2. Check the order flow', 40],
      // A `3)` label keeps its own number.
      [1, 'perps-shared 3) Confirm the verdict', 44],
      // Of two rows marked in one millisecond, the last stays.
      [1, 'perps-shared 5. Record the evidence again', 45],
      [1, '1. Run the shared checklist', 60],
      [2, 'perps-client 1. Check the client', 60],
      [2, '2. Complete the review', 120],
    ],
  );
});

test('a relaunched context or an oversized child keeps the parent marks', () => {
  const parentsOnly = ['1. Run the shared checklist', '2. Complete the review'];
  assert.deepEqual(
    receiptChecklistMarks(reviewRun(), context, 2).map((mark) => mark.label),
    parentsOnly,
  );
  const run = reviewRun();
  run.metrics.subtasks![0].checklistTiming!.events = Array.from(
    { length: RECEIPT_CHILD_MARK_LIMIT + 1 },
    (_, index) => ({
      stepNumber: index + 1,
      label: `Row ${index + 1}`,
      checkedAt: at(1 + index / 10),
    }),
  );
  assert.deepEqual(
    receiptChecklistMarks(run, context).map((mark) => mark.label),
    parentsOnly,
  );
});

test('a long rule title is cut to the receipt title budget', () => {
  const run = reviewRun();
  run.metrics.subtasks![0].checklistTiming!.events = [
    { stepNumber: 1, label: 'x'.repeat(200), checkedAt: at(20) },
  ];
  const [first] = receiptChecklistMarks(run, context);
  assert.equal(first.label.length, RECEIPT_CHILD_TITLE_CHARS);
  assert.ok(first.label.endsWith('…'));
  // An emoji just before the cut stays whole.
  run.metrics.subtasks![0].checklistTiming!.events = [
    {
      stepNumber: 1,
      label: `${'y'.repeat(60)}🧪🧪 and more text past the limit`,
      checkedAt: at(20),
    },
  ];
  const [cut] = receiptChecklistMarks(run, context);
  // encodeURIComponent throws on half an emoji (a lone surrogate).
  assert.ok(encodeURIComponent(cut.label).length > 0);
  assert.ok(cut.label.includes('🧪🧪'));
  assert.ok(cut.label.endsWith('…'));
});

test('live progress keeps the parent marks only', () => {
  assert.deepEqual(
    contextChecklistMarks(reviewRun(), context).map((mark) => mark.label),
    ['1. Run the shared checklist', '2. Complete the review'],
  );
});
