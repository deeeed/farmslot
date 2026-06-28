import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoadmapItem, RoadmapRefineParams, RoadmapRefineResult } from '../../src/index.js';
import {
  Methods,
  ROADMAP_ITEM_STAGES,
  ROADMAP_SOURCE_KINDS,
  RoadmapMethods,
} from '../../src/index.js';

test('roadmap protocol exports method constants and stages', () => {
  assert.equal(Methods.ROADMAP_LIST, 'roadmap.list');
  assert.equal(Methods.ROADMAP_GET, 'roadmap.get');
  assert.equal(Methods.ROADMAP_SAVE, 'roadmap.save');
  assert.equal(Methods.ROADMAP_DELETE, 'roadmap.delete');
  assert.equal(Methods.ROADMAP_REFINE, 'roadmap.refine');
  assert.equal(Methods.ROADMAP_PROMOTE, 'roadmap.promote');
  assert.equal(RoadmapMethods.list, 'roadmap.list');
  assert.equal(RoadmapMethods.delete, 'roadmap.delete');
  assert.equal(RoadmapMethods.refine, 'roadmap.refine');
  assert.equal(RoadmapMethods.promote, 'roadmap.promote');
  assert.deepEqual(ROADMAP_ITEM_STAGES, [
    'rough',
    'refining',
    'refined',
    'promoted',
    'parked',
    'archived',
  ]);
  assert.deepEqual(ROADMAP_SOURCE_KINDS, ['manual', 'import', 'agent', 'external']);
});

test('roadmap item carries markdown location, tags, source, and promotion metadata', () => {
  const item = {
    id: 'ri_123',
    kind: 'roadmap-item',
    project: 'farmslot-farm',
    title: 'Roadmap idea',
    stage: 'refined',
    tags: ['roadmap', 'command-center'],
    source: { kind: 'manual', ref: 'operator-note' },
    body: '## Problem\n\nDefine the idea.\n',
    promotion: [
      {
        backlogItemId: 'backlog-1',
        specPath: '.backlog/specs/roadmap-idea.md',
        createdAt: '2026-06-28T00:00:00.000Z',
      },
    ],
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    filePath: '.roadmap/projects/farmslot-farm/items/2026-06-28-roadmap-idea.md',
    fileHash: 'abc123',
  } satisfies RoadmapItem;

  assert.deepEqual(item.tags, ['roadmap', 'command-center']);
  assert.equal(item.promotion?.[0]?.backlogItemId, 'backlog-1');
});

test('roadmap refine params support runner and model overrides', () => {
  const params = {
    itemId: 'ri_123',
    runner: 'codex',
    model: 'gpt-5',
    runnerCommand: '{{runner}} --model {{model}} {{prompt_path}}',
    launch: true,
  } satisfies RoadmapRefineParams;
  const result = {
    item: {
      id: 'ri_123',
      kind: 'roadmap-item',
      project: 'farmslot-farm',
      title: 'Idea',
      stage: 'refining',
      source: { kind: 'manual' },
      body: 'Raw idea.',
      createdAt: '2026-06-28T00:00:00.000Z',
      updatedAt: '2026-06-28T00:00:00.000Z',
      filePath: '.roadmap/projects/farmslot-farm/items/idea.md',
      fileHash: 'hash',
    },
    promptPath: '.roadmap/refinement-prompts/idea.md',
    tmuxSession: 'roadmap-ri-123',
    tmuxTarget: 'roadmap-ri-123',
    launched: true,
    attachCommand: 'tmux attach -t roadmap-ri-123',
    runner: params.runner,
    model: params.model,
    runnerCommand: params.runnerCommand,
  } satisfies RoadmapRefineResult;

  assert.equal(result.runner, 'codex');
  assert.equal(result.model, 'gpt-5');
});
