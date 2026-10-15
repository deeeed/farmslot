import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '../../runtime/mock-pty.test-support.js';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'manual-backlog-admission-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(temporary, 'backlog.json');
process.env.FARMSLOT_BACKLOG_SPEC_DIR = temporary;
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(temporary, 'queue.json');
process.env.FARMSLOT_RUNS_DIR = path.join(temporary, 'runs');

const backlog = await import('../../backlog/store.js');
const queue = await import('../../backlog/dispatch-queue.js');
const { getAllRuns } = await import('../../runs/store.js');
const { planRunCreation } = await import('../run.js');

backlog.initBacklogStore(() => {});
queue.initDispatchQueue(
  () => {},
  async () => {},
);
test.after(async () => {
  await backlog.flushBacklogForTests();
  await queue.persistQueueNow();
  await rm(temporary, { recursive: true, force: true });
});

test('interactive creation refuses manual backlog refs before generating placeholder ticket data', async () => {
  const before = getAllRuns().map((run) => run.id);
  for (const ticketOrPr of ['MANUAL-000146', '  MANUAL-000146  ', 'manual-000146']) {
    await assert.rejects(
      planRunCreation({
        project: 'farmslot-farm',
        flowType: 'dev',
        mode: 'interactive',
        ticketOrPr,
      }),
      /manual backlog refs.*farmslot backlog enqueue MANUAL-000146/,
    );
  }
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    before,
  );
});

test('interactive backlog handoff keeps its manual identity, title, specification and ACs', async () => {
  const specPath = path.join(temporary, 'task.md');
  await writeFile(
    specPath,
    '# Backlog specification\n\nKeep the authored task.\n\n## Acceptance Criteria\n- Preserve the criterion\n',
  );
  const { item } = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      flowType: 'dev',
      mode: 'interactive',
      sourceKind: 'manual',
      title: 'Authored backlog task',
      notes: 'Keep the operator notes.',
      specPath,
      status: 'ready',
    },
    { kind: 'system' },
  );
  const { queueItem } = await backlog.enqueueBacklogItem({ itemId: item.id });
  const { params } = await planRunCreation({
    project: item.project,
    flowType: item.flowType,
    mode: 'interactive',
    ticketOrPr: item.sourceRef,
    backlogItemId: item.id,
    ticketData: queueItem.ticketData,
    initialContext: queueItem.initialContext,
  });
  assert.equal(params.ticketOrPr, item.sourceRef);
  assert.equal(params.ticketData?.title, item.title);
  assert.match(params.ticketData?.description ?? '', /Keep the authored task/);
  assert.deepEqual(params.ticketData?.acceptanceCriteria, ['Preserve the criterion']);
  assert.match(params.initialContext ?? '', /Keep the operator notes/);
});

test('interactive free-text tasks still retain their full context', async () => {
  const ticketOrPr = 'Investigate the local task\n\nKeep the detailed operator instructions.';
  const { params } = await planRunCreation({
    project: 'farmslot-farm',
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr,
  });
  assert.match(params.ticketOrPr, /^DEV-/);
  assert.equal(params.ticketData?.description, ticketOrPr);
});
