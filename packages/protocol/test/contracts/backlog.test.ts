import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogItem } from '../../src/index.js';
import {
  assertBacklogLaunchPlan,
  BACKLOG_SOURCE_KINDS,
  BACKLOG_STATUSES,
  BacklogMethods,
  type BacklogRefinementSessionGetResult,
  type BacklogRefineParams,
  type BacklogRefineResult,
  Events,
  Methods,
} from '../../src/index.js';

test('backlog protocol exports method constants and statuses', () => {
  assert.equal(Methods.BACKLOG_CREATE, 'backlog.create');
  assert.equal(BacklogMethods.enqueue, 'backlog.enqueue');
  assert.equal(BacklogMethods.dequeue, 'backlog.dequeue');
  assert.equal(BacklogMethods.reconcileRun, 'backlog.reconcileRun');
  assert.equal(BacklogMethods.refine, 'backlog.refine');
  assert.equal(BacklogMethods.refinementSessionGet, 'backlog.refinementSession.get');
  assert.equal(Methods.BACKLOG_REFINE, 'backlog.refine');
  assert.equal(Methods.BACKLOG_REFINEMENT_SESSION_GET, 'backlog.refinementSession.get');
  assert.equal(Events.BACKLOG_UPDATED, 'backlog.updated');
  assert.deepEqual(BACKLOG_STATUSES, [
    'candidate',
    'ready',
    'queued',
    'dispatching',
    'running',
    'done',
    'failed',
    'needs-attention',
    'archived',
  ]);
  assert.deepEqual(BACKLOG_SOURCE_KINDS, ['jira', 'github', 'manual']);
});

test('backlog refinement contracts carry runner/model overrides and session identity', () => {
  const refineParams = {
    itemId: 'backlog-1',
    runner: 'codex',
    model: 'gpt-5.6-sol',
    launch: true,
  } satisfies BacklogRefineParams;
  const refineResult = {
    item: {
      id: 'backlog-1',
      project: 'farmslot-farm',
      title: 'Refine me',
      sourceKind: 'manual',
      sourceRef: 'MANUAL-000087',
      flowType: 'dev',
      status: 'candidate',
      priority: 10,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } satisfies BacklogItem,
    promptPath: '.backlog/refinement-prompts/example.md',
    tmuxSession: 'backlog-manual-000087',
    tmuxTarget: 'backlog-manual-000087:0.0',
    launched: true,
    // Matches attachCommandForSession: shellQuote(`=${session}`) → '=session' inside single quotes.
    attachCommand: "tmux attach -t '=backlog-manual-000087'",
    runner: 'codex',
    model: 'gpt-5.6-sol',
  } satisfies BacklogRefineResult;
  const session = {
    itemId: 'backlog-1',
    tmuxSession: 'backlog-manual-000087',
    tmuxTarget: 'backlog-manual-000087:0.0',
    exists: true,
    attachCommand: "tmux attach -t '=backlog-manual-000087'",
  } satisfies BacklogRefinementSessionGetResult;

  assert.equal(refineParams.runner, 'codex');
  assert.equal(refineParams.model, 'gpt-5.6-sol');
  assert.equal(refineResult.tmuxSession, session.tmuxSession);
  assert.equal(refineResult.tmuxTarget, session.tmuxTarget);
  assert.equal(session.exists, true);
  assert.match(refineResult.attachCommand, /tmux attach -t '=backlog-/);
});

test('backlog protocol carries optional roadmap spec metadata and tags', () => {
  const item = {
    id: 'backlog-1',
    project: 'farmslot-farm',
    title: 'Markdown spec',
    sourceKind: 'manual',
    sourceRef: 'MANUAL-000001',
    flowType: 'dev',
    status: 'candidate',
    notes: 'draft',
    tags: ['roadmap'],
    roadmapItemId: 'ri_123',
    specPath: '.backlog/specs/markdown-spec.md',
    priority: 10,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
  } satisfies BacklogItem;

  assert.deepEqual(item.tags, ['roadmap']);
  assert.equal(item.roadmapItemId, 'ri_123');
  assert.equal(item.specPath, '.backlog/specs/markdown-spec.md');
});

test('backlog launch plan validates baseline and comparison variants', () => {
  assert.doesNotThrow(() =>
    assertBacklogLaunchPlan({
      id: 'lp_1',
      version: 1,
      candidates: [
        {
          id: 'base',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'slot-a' },
        },
        {
          id: 'sonnet',
          role: 'comparison',
          runner: 'claude',
          model: 'sonnet',
          variant: 'claude-sonnet',
          slotPolicy: { kind: 'pool', allowedSlots: ['slot-b', 'slot-c'] },
        },
      ],
    }),
  );

  assert.throws(
    () =>
      assertBacklogLaunchPlan({
        id: 'lp_bad',
        version: 1,
        candidates: [
          { id: 'base-a', role: 'baseline', slotPolicy: { kind: 'spread' } },
          { id: 'base-b', role: 'baseline', slotPolicy: { kind: 'spread' } },
        ],
      }),
    /exactly one baseline/,
  );

  assert.throws(
    () =>
      assertBacklogLaunchPlan({
        id: 'lp_dup',
        version: 1,
        candidates: [
          { id: 'base', role: 'baseline', slotPolicy: { kind: 'spread' } },
          {
            id: 'a',
            role: 'comparison',
            variant: 'same',
            slotPolicy: { kind: 'spread' },
          },
          {
            id: 'b',
            role: 'comparison',
            variant: 'same',
            slotPolicy: { kind: 'spread' },
          },
        ],
      }),
    /duplicate comparison variant/,
  );
});
