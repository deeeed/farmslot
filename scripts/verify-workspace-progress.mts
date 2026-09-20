#!/usr/bin/env tsx
// Read-only live proof. Set FARMSLOT_REVIEW_RUN_ID to a real static review run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Run, TaskProgressResult } from '@farmslot/protocol';

import { taskProgressUpdateTargetsRun as desktopAccepts } from '../apps/command-center/ui/src/components/runs/run-detail-model.js';
import { taskProgressUpdateTargetsRun as companionAccepts } from '../apps/companion/src/lib/task-progress.js';

const runId = process.env.FARMSLOT_REVIEW_RUN_ID;
assert(runId, 'Set FARMSLOT_REVIEW_RUN_ID to a real review workspace run');
const helper = fileURLToPath(new URL('../apps/command-center/scripts/cdp.mjs', import.meta.url));
function rpc<T>(method: string, params: object): T {
  return JSON.parse(
    execFileSync(process.execPath, [helper, 'gateway', method, JSON.stringify(params)], {
      encoding: 'utf8',
      timeout: 30_000,
    }),
  ) as T;
}
const { run } = rpc<{ run: Run }>('run.get', { runId });
assert(run.reviewWorkspace, 'Run must have a real review workspace');
assert(!run.slotId, 'Run must be slot-free');
const progress = rpc<TaskProgressResult>('task.progress', { slotId: '', runId });
assert.equal(progress.slotId, '');
assert(progress.structured, 'Gateway must project a real checklist');
const update = { slotId: progress.slotId, runId: run.id };
for (const accepts of [desktopAccepts, companionAccepts]) {
  assert.equal(accepts(run, update), true, 'Accept the workspace progress identity');
  assert.equal(accepts({ ...run, id: 'another-run' }, update), false, 'Reject another run');
  assert.equal(
    accepts({ ...run, reviewWorkspace: undefined }, update),
    false,
    'Reject the same empty-slot identity when no workspace exists',
  );
}
const children = progress.structured.phases.flatMap((phase) =>
  phase.steps.flatMap((step) => (step.subtask ? [step.subtask] : [])),
);
assert(children.length > 0, 'Real reviewer must register a child checklist');
assert(!progress.acceptanceStatusError, progress.acceptanceStatusError);
console.log(
  JSON.stringify({
    status: 'pass',
    runId,
    children,
    acceptanceCriteria: progress.acceptanceCriteria ?? [],
    acceptanceStatus: progress.acceptanceStatus ?? null,
    subtasks: run.metrics?.subtasks ?? [],
  }),
);
