import assert from 'node:assert/strict';
import test from 'node:test';

import type { QueueItem, Run } from '@farmslot/protocol';

import { buildQueuePreviewParams } from '../backlog/dispatch-queue.js';
import { resolveDispatchPreviewFromFleet } from '../methods/dispatch.js';
import { buildSlotClaimStatus } from '../methods/dispatch/slot-scoring.js';
import { assertDuplicateRunAllowed } from '../methods/run.js';
import {
  buildDispatchPreviewParamsForRun,
  determineSelectionMethodForRun,
} from '../run-engine/dispatch-policy.js';
import { buildTaskFolderPrefix, findTaskDirCollisions } from '../tasks/writer.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'monitoring',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: overrides.prNumber,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-15T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary,
    reviewTier: overrides.reviewTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
  };
}

test('ADR-024 identity propagates consistently across queue, run preview, duplicate policy, and task collision', () => {
  const run = makeRun({
    id: 'cmp-run',
    familyId: 'family-cmp',
    lane: 'comparison',
    variant: 'codex',
    flowType: 'review-pr',
    ticketOrPr: 'example-org/example-mobile#42',
  });
  const queueItem: QueueItem = {
    id: 'queue-1',
    flowType: run.flowType,
    project: run.project,
    ticketOrPr: run.ticketOrPr,
    familyId: run.familyId,
    parentRunId: run.parentRunId ?? null,
    familyRootTicketOrPr: run.familyRootTicketOrPr,
    lane: run.lane,
    variant: run.variant,
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };

  assert.deepEqual(buildQueuePreviewParams(queueItem), buildDispatchPreviewParamsForRun(run));

  const preview = resolveDispatchPreviewFromFleet(buildDispatchPreviewParamsForRun(run), [
    {
      slot: 'held-slot',
      machine: 'demo',
      platform: 'cli',
      project: 'example-mobile-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'review/example-org-example-mobile-42-codex',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'held',
      phase: 'ci-watch',
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: 'old-run',
      currentFlowType: 'review-pr',
      currentTicketOrPr: run.ticketOrPr,
      currentMode: 'interactive',
      currentFamilyId: run.familyId,
      currentLane: run.lane,
      currentVariant: run.variant,
      dispatchedAt: null,
      completedAt: null,
      runner: 'codex',
      model: 'gpt-5.5',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    } as any,
  ]);
  assert.equal(preview.preview.slotId, 'held-slot');
  assert.equal(
    determineSelectionMethodForRun(
      run,
      undefined,
      [{ lifecycle: 'held', slot: 'held-slot' }],
      'held-slot',
    ),
    'affinity',
  );
  const claim = buildSlotClaimStatus({
    runId: run.id,
    taskId: run.ticketOrPr,
    flowSubdir: 'review',
    taskFolderId: 'example-org-example-mobile-42-codex-0415-1000',
    flowType: 'review-pr',
    mode: 'interactive',
    runner: 'codex',
    model: 'gpt-5.5',
    currentRun: run,
  });
  assert.equal(claim.current_family_id, run.familyId);
  assert.equal(claim.current_lane, run.lane);
  assert.equal(claim.current_variant, run.variant);
  assert.equal(claim.current_ticket_or_pr, run.ticketOrPr);
  assert.equal(
    determineSelectionMethodForRun(
      run,
      'manual-slot',
      [{ lifecycle: 'held', slot: 'held-slot' }],
      'held-slot',
    ),
    'user-specified',
  );
  assert.equal(
    determineSelectionMethodForRun(
      run,
      undefined,
      [{ lifecycle: 'ready', slot: 'ready-slot' }],
      'ready-slot',
    ),
    'scored',
  );

  assert.doesNotThrow(() =>
    assertDuplicateRunAllowed(
      {
        ticketOrPr: run.ticketOrPr,
        project: run.project,
        flowType: 'dev',
        lane: 'comparison',
        variant: 'claude',
        familyId: run.familyId,
      },
      [run],
    ),
  );

  const codexEntry = `${buildTaskFolderPrefix(run.ticketOrPr, 'codex')}0415-1000`.replace(/-$/, '');
  const claudeEntry = `${buildTaskFolderPrefix(run.ticketOrPr, 'claude')}0415-1001`.replace(
    /-$/,
    '',
  );
  assert.deepEqual(findTaskDirCollisions([codexEntry, claudeEntry], run.ticketOrPr, 'codex'), [
    codexEntry,
  ]);
});
