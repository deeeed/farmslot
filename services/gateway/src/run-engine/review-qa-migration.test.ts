import assert from 'node:assert/strict';
import test from 'node:test';

import { type ProjectQaConfig, resolveReviewQaDispatch } from '@farmslot/protocol';

import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { reviewQaMigrationPatch } from './review-qa-migration.js';

const qa: ProjectQaConfig = {
  default_profile: 'changes',
  profiles: [{ id: 'changes', title: 'Validate changes', template_id: 'review-pr/shared' }],
};

test('unstarted persisted live review migrates once while preserving run identity and placement', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example',
    ticketOrPr: 'example/app#410',
    slotId: 'pinned',
    allowedSlots: ['pinned'],
    reviewValidationDepth: 'full-live',
    executionTemplateId: 'review-pr/old',
  });
  t.after(() => {
    updateRun(run.id, { status: 'done' });
    return deleteRun(run.id);
  });
  const patch = reviewQaMigrationPatch(run, qa);
  assert.equal(patch?.flowType, 'qa');
  assert.equal(patch?.reviewQaContract?.legacy?.executionTemplateId, 'review-pr/old');
  const migrated = updateRun(run.id, patch!);
  assert.equal(migrated.id, run.id);
  assert.equal(migrated.slotId, 'pinned');
  assert.deepEqual(migrated.allowedSlots, ['pinned']);
  assert.equal(migrated.qa?.profile.template_id, 'review-pr/shared');
  const restarted = JSON.parse(JSON.stringify(migrated));
  assert.equal(reviewQaMigrationPatch(restarted, qa), undefined);
});

test('started and completed records retain their original combined-review meaning', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example',
    ticketOrPr: 'example/app#411',
    reviewValidationDepth: 'full-live',
  });
  t.after(() => {
    updateRun(run.id, { status: 'done' });
    return deleteRun(run.id);
  });
  for (const status of ['preparing', 'monitoring', 'done', 'failed', 'cancelled'] as const) {
    const old = { ...run, status };
    assert.equal(reviewQaMigrationPatch(old, qa), undefined);
    assert.equal(old.flowType, 'review-pr');
    assert.equal(old.reviewValidationDepth, 'full-live');
  }
  const worker = { ...run, metrics: { ...run.metrics, runnerSessionId: 'already-launched' } };
  assert.equal(reviewQaMigrationPatch(worker, qa), undefined);
});

test('new QA runs require trusted preset resolution and snapshot the result', async (t) => {
  const params = {
    flowType: 'qa' as const,
    project: 'example',
    ticketOrPr: 'Previous day changes',
    slotId: 'pinned',
  };
  assert.throws(() => createRun(params), /resolved farm profile/);
  const selected = resolveReviewQaDispatch(params, qa)!;
  const run = createRun(params, { reviewQa: selected });
  t.after(() => {
    updateRun(run.id, { status: 'done' });
    return deleteRun(run.id);
  });
  assert.equal(run.flowType, 'qa');
  assert.equal(run.reviewValidationDepth, undefined);
  assert.equal(run.agentContexts?.[0].role, 'primary');
  if (selected.qa) selected.qa.profile.title = 'Changed later';
  assert.equal(run.qa?.profile.title, 'Validate changes');
});

test('unstarted QA preserves its admitted profile snapshot or blocks a changed definition', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example',
    ticketOrPr: 'example/app#412',
    reviewValidationDepth: 'full-live',
  });
  t.after(() => {
    updateRun(run.id, { status: 'done' });
    return deleteRun(run.id);
  });
  const migrated = updateRun(run.id, reviewQaMigrationPatch(run, qa)!);
  const frozen = JSON.parse(JSON.stringify(migrated));
  const changedDefault = {
    ...qa,
    default_profile: 'other',
    profiles: [...qa.profiles, { id: 'other', title: 'Other', template_id: 'validation/other' }],
  };
  assert.equal(reviewQaMigrationPatch(migrated, changedDefault), undefined);
  const edited = structuredClone(qa);
  edited.profiles[0].inputs = { scope: 'release' };
  assert.throws(() => reviewQaMigrationPatch(migrated, edited), /changed after run admission/);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated)), frozen);
  const historical = { ...migrated, status: 'monitoring' as const };
  assert.equal(reviewQaMigrationPatch(historical, edited), undefined);
});

test('legacy static runs require explicit workspace migration and modern workspaces are untouched', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example',
    ticketOrPr: 'example/app#413',
    reviewValidationDepth: 'static-code',
    slotId: 'pinned',
  });
  t.after(() => {
    updateRun(run.id, { status: 'done' });
    return deleteRun(run.id);
  });
  const before = JSON.parse(JSON.stringify(run));
  assert.throws(() => reviewQaMigrationPatch(run, qa), /explicit workspace migration/);
  assert.deepEqual(JSON.parse(JSON.stringify(run)), before);
  const workspace = { ...run, slotId: null, reviewWorkspaceTarget: { machine: 'review-host' } };
  assert.equal(reviewQaMigrationPatch(workspace, qa), undefined);
});

test('delivery and session history prevent migration even if allocation status was restored', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example',
    ticketOrPr: 'example/app#414',
    reviewValidationDepth: 'full-live',
    slotId: 'pinned',
  });
  t.after(() => {
    updateRun(run.id, { status: 'done' });
    return deleteRun(run.id);
  });
  for (const marker of ['promptDeliveryStartedAt', 'attemptStartedAt', 'startedAt'] as const) {
    const delivered = {
      ...run,
      agentContexts: run.agentContexts!.map((context) => ({
        ...context,
        [marker]: '2026-09-15T00:00:00Z',
      })),
    };
    assert.equal(reviewQaMigrationPatch(delivered, qa), undefined);
  }
  assert.equal(
    reviewQaMigrationPatch({ ...run, metrics: { ...run.metrics, sessionTurns: 1 } }, qa),
    undefined,
  );
});
