import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogItem, Run } from '@farmslot/protocol';

import { activeLinkedRunForBacklogItem, linkedRunForBacklogItem } from './linked-run-model.js';

const now = '2026-07-03T00:00:00.000Z';

function backlog(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'backlog-1',
    project: 'farmslot-farm',
    title: 'Linked run item',
    sourceKind: 'manual',
    sourceRef: 'MANUAL-000001',
    flowType: 'dev',
    status: 'running',
    priority: 10,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    slotId: 'macwork-ff-1',
    branch: 'main',
    taskFile: 'tasks/MANUAL-000001.md',
    steps: [],
    decisions: [],
    metrics: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Run;
}

test('linkedRunForBacklogItem prefers active linked run over newer terminal run', () => {
  const item = backlog();
  const selected = linkedRunForBacklogItem(
    [
      run({
        id: 'done-run',
        backlogItemId: item.id,
        status: 'done',
        updatedAt: '2026-07-03T02:00:00.000Z',
      }),
      run({
        id: 'active-run',
        backlogItemId: item.id,
        status: 'monitoring',
        updatedAt: '2026-07-03T01:00:00.000Z',
      }),
    ],
    item,
  );

  assert.equal(selected?.id, 'active-run');
});

test('linkedRunForBacklogItem chooses newest linked active run', () => {
  const item = backlog();
  const selected = linkedRunForBacklogItem(
    [
      run({
        id: 'older-active',
        backlogItemId: item.id,
        status: 'human-gating',
        updatedAt: '2026-07-03T01:00:00.000Z',
      }),
      run({
        id: 'newer-active',
        backlogItemId: item.id,
        status: 'monitoring',
        updatedAt: '2026-07-03T02:00:00.000Z',
      }),
    ],
    item,
    { allowSourceRefInference: true },
  );

  assert.equal(selected?.id, 'newer-active');
});

test('linkedRunForBacklogItem falls back to newest linked terminal run', () => {
  const item = backlog();
  const selected = linkedRunForBacklogItem(
    [
      run({
        id: 'older',
        backlogItemId: item.id,
        status: 'failed',
        updatedAt: '2026-07-03T01:00:00.000Z',
      }),
      run({
        id: 'newer',
        backlogItemId: item.id,
        status: 'done',
        updatedAt: '2026-07-03T02:00:00.000Z',
      }),
    ],
    item,
  );

  assert.equal(selected?.id, 'newer');
});

test('linkedRunForBacklogItem supports legacy backlog runId linkage', () => {
  const item = backlog({ runId: 'legacy-run' });
  assert.equal(linkedRunForBacklogItem([run({ id: 'legacy-run' })], item)?.id, 'legacy-run');
});

test('linkedRunForBacklogItem projects an out-of-band run by exact project and source ref', () => {
  const item = backlog({ status: 'candidate' });
  const selected = linkedRunForBacklogItem(
    [
      run({ id: 'wrong-project', project: 'metamask-core-farm' }),
      run({ id: 'out-of-band', status: 'human-gating' }),
    ],
    item,
    { allowSourceRefInference: true },
  );

  assert.equal(selected?.id, 'out-of-band');
  assert.equal(
    activeLinkedRunForBacklogItem([selected!], item, { allowSourceRefInference: true })?.id,
    'out-of-band',
  );
  assert.equal(
    linkedRunForBacklogItem([selected!], item),
    undefined,
    'detail/history consumers require durable linkage',
  );
});

test('linkedRunForBacklogItem prefers explicit linkage over inferred source-ref matches', () => {
  const item = backlog();
  const selected = linkedRunForBacklogItem(
    [
      run({
        id: 'explicit',
        backlogItemId: item.id,
        status: 'done',
        updatedAt: '2026-07-03T01:00:00.000Z',
      }),
      run({
        id: 'inferred',
        status: 'monitoring',
        updatedAt: '2026-07-03T02:00:00.000Z',
      }),
    ],
    item,
    { allowSourceRefInference: true },
  );

  assert.equal(selected?.id, 'explicit');
  assert.equal(
    activeLinkedRunForBacklogItem([run({ id: 'done', status: 'done' })], item),
    undefined,
  );
});
