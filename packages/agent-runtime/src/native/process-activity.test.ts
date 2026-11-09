import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProcessProductEdit } from '@farmslot/protocol';

import {
  deriveProcessActivity,
  hasProcessRootCause,
  type ProcessActivityFacts,
} from './process-activity.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8, 0, 0, seconds)).toISOString();
const complete = { status: 'complete' as const, reason: 'qualified fixture source' };

function facts(): ProcessActivityFacts {
  return {
    capturedAt: at(60),
    attempt: {
      runId: 'run',
      contextId: 'worker',
      attemptId: 'attempt',
      role: 'fix-bug',
      engineGeneration: 1,
      startedAt: at(0),
      frozenAt: at(60),
      executionNodeId: 'node',
    },
    sources: ['signal', 'history', 'baseline'].map((id) => ({
      id,
      kind: 'task-artifact',
      contextId: 'worker',
      executionNodeId: 'node',
      clockId: 'node:node',
    })),
    checklist: {
      events: [{ stepNumber: 1, label: 'Start', checkedAt: at(1) }],
      expectedSteps: 1,
      complete: true,
      source: { sourceId: 'signal' },
      workerStatus: 'complete',
    },
    commits: [],
    productEdits: [edit(30)],
    firstBaselineRun: { at: at(20), recipeRunId: 'baseline', source: { sourceId: 'baseline' } },
    rootCause: { present: true, source: { sourceId: 'signal' } },
    markCalls: [],
    coverage: {
      checklist: complete,
      commits: complete,
      productEdits: complete,
      baseline: complete,
      rootCause: complete,
      markCalls: complete,
    },
  };
}

function edit(seconds: number, overrides: Partial<ProcessProductEdit> = {}): ProcessProductEdit {
  return {
    at: at(seconds),
    completedAt: at(seconds),
    path: 'src/value.ts',
    status: 'observed',
    classification: 'product',
    source: { sourceId: 'history', sequence: seconds },
    ...overrides,
  };
}

test('a verified baseline before the product edit supports negative labels', () => {
  const process = deriveProcessActivity(facts());
  assert.equal(process.labels.skipped_checklist.value, false);
  assert.equal(process.labels.fix_before_baseline.value, false);
});

test('late bulk ticks preserve the observed skip and event order', () => {
  const input = facts();
  input.productEdits = [edit(10)];
  input.checklist.events = [
    { stepNumber: 14, label: 'CI receipt', checkedAt: at(40) },
    { stepNumber: 1, label: 'Start', checkedAt: at(50) },
  ];
  const process = deriveProcessActivity(input);
  assert.equal(process.labels.skipped_checklist.value, true);
  assert.equal(process.labels.fix_before_baseline.value, true);
  assert.deepEqual(process.checklist.events, input.checklist.events);
  assert.equal(process.checklist.events?.[0].stepNumber, 14);
});

test('empty completed checklists differ from missing capture and an early block', () => {
  const input = facts();
  input.productEdits = null;
  input.checklist = { ...input.checklist, events: [], complete: false };
  assert.equal(deriveProcessActivity(input).labels.skipped_checklist.value, true);
  input.checklist.workerStatus = 'blocked';
  assert.equal(deriveProcessActivity(input).labels.skipped_checklist.value, null);
  input.checklist.events = null;
  input.coverage.checklist = { status: 'unavailable', reason: 'source missing' };
  assert.equal(deriveProcessActivity(input).labels.skipped_checklist.value, null);
});

test('verified marker edits and requested writes do not become a pre-baseline fix', () => {
  const input = facts();
  input.productEdits = [
    edit(5, { classification: 'diagnostic-marker' }),
    edit(6, { status: 'requested' }),
    edit(30),
  ];
  const process = deriveProcessActivity(input);
  assert.equal(process.firstProductEdit?.at, at(30));
  assert.equal(process.labels.fix_before_baseline.value, false);
});

test('unverified clocks or incomplete baseline history cannot establish ordering', () => {
  const input = facts();
  input.productEdits = [edit(10)];
  input.sources = input.sources.map((source) =>
    source.id === 'history' ? { ...source, clockId: null } : source,
  );
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, null);
  assert.equal(deriveProcessActivity(input).labels.skipped_checklist.value, null);
  input.sources = facts().sources;
  input.coverage.baseline = { status: 'partial', reason: 'an earlier baseline may be missing' };
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, null);
});

test('partial edit coverage permits a witnessed violation but never an invented negative', () => {
  const input = facts();
  input.coverage.productEdits = { status: 'partial', reason: 'shell writes cannot be classified' };
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, null);
  input.productEdits = [edit(10)];
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, true);
  input.firstBaselineRun = null;
  input.coverage.baseline = { status: 'unavailable', reason: 'not recorded' };
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, null);
});

test('equal timestamps and an edit overlapping baseline start leave the order unknown', () => {
  const input = facts();
  input.productEdits = [edit(10, { completedAt: at(30) })];
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, null);
  input.productEdits = [edit(20)];
  assert.equal(deriveProcessActivity(input).labels.fix_before_baseline.value, null);
});

test('Root Cause requires a real nonempty worker section, not template instructions or a fenced heading', () => {
  assert.equal(hasProcessRootCause('Write `## Root Cause` in TASK.md.'), false);
  assert.equal(hasProcessRootCause('```md\n## Root Cause\nquoted\n```'), false);
  assert.equal(hasProcessRootCause('## Root Cause\n\n## Validation\npassed'), false);
  assert.equal(hasProcessRootCause('## Root Cause\nThe listener captures stale state.\n'), true);
  assert.equal(hasProcessRootCause('## Root Cause\n```ts\nlistener(oldState);\n```'), true);
});
