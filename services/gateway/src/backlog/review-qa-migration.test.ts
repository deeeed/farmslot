import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectQaConfig, QueueItem } from '@farmslot/protocol';

import { migrateQueuedReviewQa } from './review-qa-migration.js';

const config: ProjectQaConfig = {
  default_profile: 'pr',
  profiles: [{ id: 'pr', title: 'PR validation', template_id: 'review-pr/autonomous' }],
};

function queued(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'receipt-owned-row',
    project: 'example',
    flowType: 'review-pr',
    ticketOrPr: 'example/app#42',
    priority: 10,
    status: 'queued',
    createdAt: '2026-09-15T00:00:00Z',
    slotId: 'pinned-slot',
    allowedSlots: ['pinned-slot'],
    runner: 'selected-runner',
    model: 'selected-model',
    reviewValidationDepth: 'full-live',
    reviewTier: 'full',
    ...overrides,
  };
}

test('pending live review migrates in place without changing its execution constraints', () => {
  const item = queued();
  assert.equal(migrateQueuedReviewQa(item, config), true);
  assert.equal(item.id, 'receipt-owned-row');
  assert.equal(item.flowType, 'qa');
  assert.equal(item.slotId, 'pinned-slot');
  assert.deepEqual(item.allowedSlots, ['pinned-slot']);
  assert.equal(item.runner, 'selected-runner');
  assert.equal(item.model, 'selected-model');
  assert.deepEqual(item.reviewQaContract, {
    version: 1,
    legacy: { validationDepth: 'full-live', tier: 'full' },
  });
  assert.equal(item.reviewTier, undefined);
  assert.equal(item.reviewValidationDepth, undefined);
  const restarted = JSON.parse(JSON.stringify(item)) as QueueItem;
  assert.equal(migrateQueuedReviewQa(restarted, config), false);
  assert.deepEqual(restarted, item);
});

test('claimed, completed and cancelled admissions retain their old contract', () => {
  for (const input of [
    queued({ status: 'dispatching' }),
    queued({ runId: 'existing-run' }),
    queued({ status: 'cancelled' }),
  ]) {
    const before = structuredClone(input);
    assert.equal(migrateQueuedReviewQa(input, config), false);
    assert.deepEqual(input, before);
  }
});

test('missing profiles and ambiguous intent leave the original row intact for repair', () => {
  for (const item of [queued(), queued({ reviewValidationDepth: undefined })]) {
    const before = structuredClone(item);
    assert.throws(() => migrateQueuedReviewQa(item), /Configure|ambiguous/);
    assert.deepEqual(item, before);
  }
});

test('normalized QA is revalidated when the farm removes its preset', () => {
  const item = queued();
  migrateQueuedReviewQa(item, config);
  assert.throws(() => migrateQueuedReviewQa(item), /Configure this farm/);
  assert.equal(item.id, 'receipt-owned-row');
  assert.equal(item.flowType, 'qa');
});

test('legacy live templates are retained as provenance and replaced by the farm QA preset', () => {
  const item = queued({
    executionTemplateId: 'review-pr/old-worker',
    taskTemplate: { fileName: 'review-pr.md' },
  });
  migrateQueuedReviewQa(item, config);
  assert.equal(item.executionTemplateId, 'review-pr/autonomous');
  assert.equal(item.taskTemplate, undefined);
  assert.equal(item.reviewQaContract?.legacy?.executionTemplateId, 'review-pr/old-worker');
  assert.deepEqual(item.reviewQaContract?.legacy?.taskTemplate, { fileName: 'review-pr.md' });
  assert.equal(migrateQueuedReviewQa(item, config), false);
});

test('migration pins the admitted profile and effective inputs across farm default changes', () => {
  const presets: ProjectQaConfig = {
    default_profile: 'pr',
    profiles: [
      {
        id: 'pr',
        title: 'PR validation',
        template_id: 'validation/shared',
        inputs: { scope: 'pr', flags: { smoke: true } },
      },
      {
        id: 'release',
        title: 'Release validation',
        template_id: 'validation/shared',
        inputs: { scope: 'release' },
      },
    ],
  };
  const item = queued({ qaInputs: { requested: 'original' } });
  migrateQueuedReviewQa(item, presets);
  assert.equal(item.qaProfileId, 'pr');
  assert.deepEqual(item.qaInputs, { scope: 'pr', flags: { smoke: true }, requested: 'original' });
  const before = structuredClone(item);
  presets.default_profile = 'release';
  presets.profiles[0].inputs!.scope = 'changed-default';
  assert.equal(migrateQueuedReviewQa(item, presets), false);
  assert.deepEqual(item, before, 'an admitted input remains an explicit frozen value');
});

test('new preset defaults cannot add inputs to an admitted queue request', () => {
  const item = queued();
  migrateQueuedReviewQa(item, config);
  const before = structuredClone(item);
  const changed = structuredClone(config);
  changed.profiles[0].inputs = { newRuntimeAction: 'unrequested' };
  assert.throws(() => migrateQueuedReviewQa(item, changed), /adds inputs after admission/);
  assert.deepEqual(item, before);
});

test('changed templates, removed profiles and old normalized rows without pins require repair', () => {
  const item = queued();
  migrateQueuedReviewQa(item, config);
  const before = structuredClone(item);
  const changed = structuredClone(config);
  changed.profiles[0].template_id = 'validation/new-process';
  assert.throws(() => migrateQueuedReviewQa(item, changed), /template must match/);
  assert.deepEqual(item, before);
  const removed: ProjectQaConfig = {
    default_profile: 'other',
    profiles: [{ id: 'other', title: 'Other', template_id: 'review-pr/autonomous' }],
  };
  assert.throws(() => migrateQueuedReviewQa(item, removed), /does not exist/);
  const unpinned = structuredClone(item);
  delete unpinned.qaProfileId;
  delete unpinned.qaInputs;
  const original = structuredClone(unpinned);
  assert.throws(() => migrateQueuedReviewQa(unpinned, config), /lacks its admitted profile/);
  assert.deepEqual(unpinned, original);
  const missingTemplate = structuredClone(item);
  delete missingTemplate.executionTemplateId;
  assert.throws(() => migrateQueuedReviewQa(missingTemplate, config), /lacks its admitted profile/);
});

test('workspace static requests remain workspace requests and conflicting live placement is rejected', () => {
  const item = queued({
    slotId: undefined,
    allowedSlots: null,
    reviewValidationDepth: 'static-code',
    reviewTier: undefined,
    reviewWorkspaceTarget: { machine: 'review-host' },
  });
  migrateQueuedReviewQa(item);
  assert.equal(item.flowType, 'review-pr');
  assert.deepEqual(item.reviewWorkspaceTarget, { machine: 'review-host' });
  assert.equal(migrateQueuedReviewQa(item), false);
  const live = queued({ reviewWorkspaceTarget: { machine: 'review-host' } });
  const original = structuredClone(live);
  assert.throws(() => migrateQueuedReviewQa(live, config), /authorized runtime slot/);
  assert.deepEqual(live, original);
});

test('farm workflow QA defaults resolve before migration and cannot later add admitted inputs', () => {
  const item = queued();
  const farm = {
    qa: {
      review: {
        sessionIntent: 'resume' as const,
        scope: 'full' as const,
        workflow: 'qa' as const,
        qaProfileId: 'pr',
        qaInputs: { scope: 'pr' },
      },
    },
  };
  migrateQueuedReviewQa(item, config, farm);
  assert.deepEqual(item.qaInputs, { scope: 'pr' });
  const before = structuredClone(item);
  const changed = {
    qa: { review: { ...farm.qa.review, qaInputs: { scope: 'pr', added: 'unrequested' } } },
  };
  assert.throws(() => migrateQueuedReviewQa(item, config, changed), /adds inputs after admission/);
  assert.deepEqual(item, before);
});
