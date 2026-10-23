import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { ORCHESTRATOR_LOCALITY } from '../core/slot-io.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import { joinSchemaWithMarkdown } from '../methods/task.js';

import {
  attachChecklistTiming,
  checklistTimingContext,
  parseChecklistTiming,
} from './checklist-timing.js';
import { generateTaskSchema } from './writer.js';

const start = '2026-10-23T01:00:00Z';
const mark = '2026-10-23T01:08:22Z';
const finish = '2026-10-23T01:10:00Z';
const markdown = '# Work\n- [x] Prepare\n- [ ] Inspect\n';
function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: 'worker',
    role: 'dev',
    label: 'Worker',
    runId: 'run-1',
    slotId: null,
    status: 'working',
    taskFile: '/task/TASK.md',
    startedAt: '2026-10-22T01:00:00Z',
    attemptStartedAt: start,
    ...overrides,
  };
}

test('timing selects the current checklist attempt, not another role or a warm reviewer first launch', () => {
  const worker = context();
  const reviewer = context({ id: 'reviewer', role: 'review', taskFile: '/task/REVIEW.md' });
  const run = makeRun({ agentContexts: [worker, reviewer] });
  assert.equal(checklistTimingContext(run, '/task/CHECKLIST.md', reviewer), worker);
  assert.equal(checklistTimingContext(run, '/task/REVIEW.md', worker), reviewer);
});

test('live signal marks use current-attempt boundaries and stopped signal freezes elapsed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checklist-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const progress = joinSchemaWithMarkdown(generateTaskSchema(markdown, 'dev'), markdown);
  const run = makeRun({ agentContexts: [context()] });
  await writeFile(
    path.join(root, 'SIGNAL.json'),
    JSON.stringify({
      status: 'blocked',
      role: 'dev',
      contextId: 'worker',
      timestamp: finish,
      checklistTiming: {
        schemaVersion: 1,
        source: 'CHECKLIST.md',
        events: [
          { stepNumber: 2, label: 'Previous round', checkedAt: '2026-10-22T02:00:00Z' },
          { stepNumber: 1, label: 'Prepare', checkedAt: mark },
        ],
      },
    }),
  );
  await attachChecklistTiming(
    ORCHESTRATOR_LOCALITY,
    path.join(root, 'CHECKLIST.md'),
    progress,
    run,
  );
  assert.equal(progress.timing?.startedAt, start);
  assert.equal(progress.timing?.finishedAt, finish);
  assert.deepEqual(
    progress.timing?.events.map((event) => event.label),
    ['Prepare'],
  );
});

test('another role or stale attempt cannot supply this checklist marks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checklist-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = makeRun({ agentContexts: [context()] });
  for (const extra of [
    { role: 'review', timestamp: finish },
    { role: 'dev', timestamp: '2026-10-22T01:00:00Z' },
  ]) {
    const progress = joinSchemaWithMarkdown(generateTaskSchema(markdown, 'dev'), markdown);
    await writeFile(
      path.join(root, 'SIGNAL.json'),
      JSON.stringify({
        ...extra,
        status: 'complete',
        checklistTiming: {
          schemaVersion: 1,
          events: [{ stepNumber: 1, label: 'Wrong attempt', checkedAt: mark }],
        },
      }),
    );
    await attachChecklistTiming(
      ORCHESTRATOR_LOCALITY,
      path.join(root, 'CHECKLIST.md'),
      progress,
      run,
    );
    assert.deepEqual(progress.timing?.events, []);
    assert.equal(progress.timing?.finishedAt, undefined);
  }
});

test('finalized primary progress retains metrics marks without a signal file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checklist-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run: Run = makeRun({
    status: 'done',
    completedAt: finish,
    agentContexts: [context({ status: 'complete', completedAt: finish })],
  });
  run.metrics.checklistTiming = {
    schemaVersion: 1,
    source: 'CHECKLIST.md',
    events: [{ stepNumber: 1, label: 'Prepare', checkedAt: mark }],
  };
  const progress = joinSchemaWithMarkdown(generateTaskSchema(markdown, 'dev'), markdown);
  await attachChecklistTiming(
    ORCHESTRATOR_LOCALITY,
    path.join(root, 'CHECKLIST.md'),
    progress,
    run,
  );
  assert.equal(progress.timing?.events[0].checkedAt, mark);
  assert.equal(progress.timing?.finishedAt, finish);
  const review = joinSchemaWithMarkdown(generateTaskSchema(markdown, 'dev'), markdown);
  await attachChecklistTiming(ORCHESTRATOR_LOCALITY, path.join(root, 'REVIEW.md'), review, run);
  assert.equal(review.timing, undefined);
});

test('parent and child timing parser ignores malformed mark events', () => {
  assert.deepEqual(
    parseChecklistTiming({
      schemaVersion: 1,
      events: [
        { stepNumber: 0, label: 'invalid', checkedAt: mark },
        { stepNumber: 1, label: 'invalid', checkedAt: 'bad' },
        { stepNumber: 1, label: 'Prepare', checkedAt: mark },
      ],
    })?.events,
    [{ stepNumber: 1, label: 'Prepare', checkedAt: mark }],
  );
});
