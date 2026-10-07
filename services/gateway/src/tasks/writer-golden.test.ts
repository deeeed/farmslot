// @farmslot:serial — writes task dirs under the repo's .sandbox/farmslot-farm/tasks
// (mock-mode task root) like writer.test.ts.
//
// Byte-for-byte TASK.md goldens for the four main flows on a run that is not
// stacked. They were captured before stacked runs existed, so any change to a
// normal run's task document shows up here as a diff. Regenerate only on purpose:
// FARMSLOT_UPDATE_TASK_GOLDENS=1.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { FlowType, Run } from '@farmslot/protocol';

process.env.FARMSLOT_DEMO_POOL = '1';

const { writeTaskFile } = await import('./writer.js');

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'task-md-golden',
);
const UPDATE = process.env.FARMSLOT_UPDATE_TASK_GOLDENS === '1';

function goldenRun(flowType: FlowType): Run {
  const prFlow = flowType === 'review-pr' || flowType === 'pr-complete';
  // A repo that does not exist: the PR comment fetch comes back empty online and
  // offline alike, so the golden never depends on live GitHub data.
  const ticket = prFlow ? 'farmslot-golden/missing#123' : `GOLDEN-${flowType.toUpperCase()}`;
  return {
    id: `run-golden-${flowType}`,
    familyId: `family-golden-${flowType}`,
    parentRunId: null,
    familyRootTicketOrPr: ticket,
    lane: 'production',
    flowType,
    mode: 'autonomous',
    status: 'writing-task',
    project: 'farmslot-farm',
    ticketOrPr: ticket,
    slotId: 'demo-ff-1',
    branch: prFlow ? 'feature/golden-pr' : `golden/${flowType}`,
    ...(prFlow ? { prNumber: 123 } : {}),
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: 'sonnet',
      runner: 'fake',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    ticketData: {
      source: 'manual',
      title: 'Golden task document',
      description: 'Render the task document for a run that is not stacked.',
      acceptanceCriteria: ['The task document is unchanged', 'No stack section appears'],
      affectedArea: 'Task writer',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  };
}

/** Strips values that change per machine or per render. */
function normalize(text: string, taskDir: string): string {
  return text
    .split(taskDir)
    .join('<TASK_DIR>')
    .split(path.basename(taskDir))
    .join('<TASK_ID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIMESTAMP>')
    .replace(/[0-9a-f]{64}/g, '<SHA256>');
}

for (const flowType of ['dev', 'fix-bug', 'review-pr', 'pr-complete'] as const) {
  test(`TASK.md for a non-stacked ${flowType} run matches its golden byte for byte`, async (t) => {
    let taskPath = '';
    t.after(async () => {
      if (taskPath) await rm(path.dirname(taskPath), { recursive: true, force: true });
    });
    taskPath = await writeTaskFile(goldenRun(flowType), { skipCollisionCheck: true });
    const actual = normalize(await readFile(taskPath, 'utf-8'), path.dirname(taskPath));
    const goldenPath = path.join(GOLDEN_DIR, `${flowType}.golden`);
    if (UPDATE) {
      await mkdir(GOLDEN_DIR, { recursive: true });
      await writeFile(goldenPath, actual, 'utf-8');
      return;
    }
    assert.equal(actual, await readFile(goldenPath, 'utf-8'));
  });
}
