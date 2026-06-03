import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { createSlotViewRecipeHostEntry } from './recipe-quality-hosts.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-slot-1',
    familyId: overrides.familyId ?? 'family-slot-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'dev',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'monitoring',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: overrides.slotId ?? 'slot-1',
    branch: overrides.branch ?? 'feat/live-recipe',
    taskFile: overrides.taskFile ?? 'tasks/live/TASK.md',
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
    createdAt: overrides.createdAt ?? '2026-04-21T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-21T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary,
    reviewTier: overrides.reviewTier,
    safetyTier: overrides.safetyTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
    ciWatchState: overrides.ciWatchState,
    engineState: overrides.engineState,
    liveRecipeContext: overrides.liveRecipeContext,
  };
}

test('slot-view host prefers live recipe provenance over decision payloads', () => {
  const run = makeRun({
    decisions: [
      {
        id: 'decision-review-1',
        type: 'engine_review_posting',
        title: 'review',
        description: 'decision-backed recipe',
        actions: [],
        createdAt: '2026-04-21T00:00:00.000Z',
        payload: {
          kind: 'review',
          prNumber: 1,
          repo: 'acme/repo',
          recommendation: 'APPROVE',
          reviewMd: 'Looks good',
          lineComments: [],
          recipeJson: '{"entry":"decision"}',
        },
      },
    ],
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'recipe-run-42',
      artifactRoot: '/tmp/recipe-run-42',
      artifactManifest: null,
      recipeJson: '{"entry":"live"}',
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: 'Prefer the selected rerun artifacts.',
      isStale: false,
      selectionReason: 'user-selected',
    },
  });

  const host = createSlotViewRecipeHostEntry(run, 'slot-1');
  assert.ok(host);
  assert.equal(host.recipeJson, '{"entry":"live"}');
  assert.equal(host.provenanceSource, 'recipe-run-artifacts');
  assert.equal(host.provenanceLabel, 'Recipe artifacts');
  assert.equal(host.provenanceDetail, 'run:recipe-run-42');
  assert.equal(host.decisionKind, null);
});

test('slot-view host keeps stale live recipe selections visible without final-artifact fallback', () => {
  const run = makeRun({
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'recipe-run-stale',
      artifactRoot: '/tmp/missing',
      artifactManifest: null,
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: true,
      selectionReason: 'user-selected',
    },
  });

  const host = createSlotViewRecipeHostEntry(run, 'slot-1');
  assert.ok(host);
  assert.equal(host.provenanceSource, 'recipe-run-artifacts');
  assert.match(host.emptyRecipeMessage ?? '', /could not be materialized/i);
  assert.equal(host.recipeJson, null);
});

test('slot-view host keeps current-artifacts bundle runnable', () => {
  const run = makeRun({
    status: 'blocked',
    decisions: [
      {
        id: 'decision-human-gate-1',
        type: 'engine_human_gate',
        title: 'human gate',
        description: 'pending review',
        actions: [],
        createdAt: '2026-04-21T00:00:00.000Z',
      },
    ],
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: null,
      artifactRoot: '/tmp/task/artifacts',
      artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
      recipeJson: '{"entry":"bundle"}',
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
      groupKind: 'current-artifacts' as any,
    } as any,
  });

  const host = createSlotViewRecipeHostEntry(run, 'slot-1', run.liveRecipeContext as any);
  assert.ok(host);
  assert.equal(host.capabilities.canRerun, true);
  assert.deepEqual(host.outputTarget, { runId: run.id, slotId: 'slot-1' });
});

test('slot-view host keeps current-artifacts runnable whenever a warm slot is available', () => {
  const run = makeRun({
    status: 'ci-watching',
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: null,
      artifactRoot: '/tmp/task/artifacts',
      artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
      recipeJson: '{"entry":"bundle"}',
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
      groupKind: 'current-artifacts' as any,
    } as any,
  });

  const host = createSlotViewRecipeHostEntry(run, 'slot-1', run.liveRecipeContext as any);
  assert.ok(host);
  assert.equal(host.capabilities.canRerun, true);
  assert.deepEqual(host.outputTarget, { runId: run.id, slotId: 'slot-1' });
});

test('slot-view host keeps current-artifacts inspect-only without a warm slot', () => {
  const run = makeRun({
    status: 'ci-watching',
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: null,
      artifactRoot: '/tmp/task/artifacts',
      artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
      recipeJson: '{"entry":"bundle"}',
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
      groupKind: 'current-artifacts' as any,
    } as any,
  });

  const host = createSlotViewRecipeHostEntry(run, '', run.liveRecipeContext as any);
  assert.ok(host);
  assert.equal(host.capabilities.canRerun, false);
  assert.equal(host.outputTarget, null);
});

test('slot-view host keeps current-artifacts runnable during pending review-posting gate', () => {
  const run = makeRun({
    status: 'blocked',
    decisions: [
      {
        id: 'decision-review-posting-1',
        type: 'engine_review_posting',
        title: 'review posting',
        description: 'pending review posting',
        actions: [],
        createdAt: '2026-04-21T00:00:00.000Z',
      },
    ],
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: null,
      artifactRoot: '/tmp/task/artifacts',
      artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
      recipeJson: '{"entry":"bundle"}',
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
      groupKind: 'current-artifacts' as any,
    } as any,
  });

  const host = createSlotViewRecipeHostEntry(run, 'slot-1', run.liveRecipeContext as any);
  assert.ok(host);
  assert.equal(host.capabilities.canRerun, true);
  assert.deepEqual(host.outputTarget, { runId: run.id, slotId: 'slot-1' });
});

test('slot-view host keeps promoted evidence inspect-only', () => {
  const run = makeRun({
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'promoted-run',
      artifactRoot: '/tmp/task/artifacts/recipe-runs/promoted-run',
      artifactManifest: [{ path: 'artifacts/evidence.png', purpose: 'screenshot' }],
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
      groupKind: 'latest-valid' as any,
    } as any,
  });

  const host = createSlotViewRecipeHostEntry(run, 'slot-1', run.liveRecipeContext as any);
  assert.ok(host);
  assert.equal(host.capabilities.canRerun, false);
  assert.equal(host.outputTarget, null);
});
