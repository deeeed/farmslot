import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  RoadmapItem,
  RoadmapPromoteParams,
  RoadmapPromotionDraftGetParams,
  RoadmapPromotionDraftListParams,
  RoadmapPromotionDraftSaveParams,
  RoadmapRefinementSessionGetParams,
  RoadmapRefinementSessionGetResult,
  RoadmapRefineParams,
  RoadmapRefineResult,
} from '../../src/index.js';
import {
  DEFAULT_ROADMAP_REFINEMENT_MODEL,
  DEFAULT_ROADMAP_REFINEMENT_RUNNER,
  Methods,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
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
  assert.equal(Methods.ROADMAP_REFINEMENT_SESSION_GET, 'roadmap.refinementSession.get');
  assert.equal(Methods.ROADMAP_PROMPT_GET, 'roadmap.prompt.get');
  assert.equal(Methods.ROADMAP_PROMOTION_DRAFT_LIST, 'roadmap.promotionDraft.list');
  assert.equal(Methods.ROADMAP_PROMOTION_DRAFT_GET, 'roadmap.promotionDraft.get');
  assert.equal(Methods.ROADMAP_PROMOTION_DRAFT_SAVE, 'roadmap.promotionDraft.save');
  assert.equal(Methods.ROADMAP_PROMOTE, 'roadmap.promote');
  assert.equal(DEFAULT_ROADMAP_REFINEMENT_RUNNER, 'codex');
  assert.equal(DEFAULT_ROADMAP_REFINEMENT_MODEL, 'gpt-5.5');
  assert.equal(RoadmapMethods.list, 'roadmap.list');
  assert.equal(RoadmapMethods.delete, 'roadmap.delete');
  assert.equal(RoadmapMethods.refine, 'roadmap.refine');
  assert.equal(RoadmapMethods.refinementSessionGet, 'roadmap.refinementSession.get');
  assert.equal(RoadmapMethods.promptGet, 'roadmap.prompt.get');
  assert.equal(RoadmapMethods.promotionDraftList, 'roadmap.promotionDraft.list');
  assert.equal(RoadmapMethods.promotionDraftGet, 'roadmap.promotionDraft.get');
  assert.equal(RoadmapMethods.promotionDraftSave, 'roadmap.promotionDraft.save');
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

test('roadmap promotion draft helpers produce attachment-shaped specs', () => {
  const drafts = parsePromotionDraftsFromRoadmapBody(
    [
      '## Backlog Drafts',
      '',
      '### Backlog Draft: Mobile follow-up',
      '',
      'Project: `metamask-mobile-farm`',
      '',
      '## Acceptance Criteria',
      '',
      '- Mobile is updated.',
    ].join('\n'),
  );
  assert.equal(drafts.length, 1);

  const attachment = promotionDraftAttachment(
    { id: 'ri_123', title: 'Parent roadmap', tags: ['perps'] },
    drafts[0]!,
    0,
  );
  assert.equal(
    attachment.virtualPath,
    '.roadmap/promotion-drafts/ri_123/01-metamask-mobile-farm-mobile-follow-up.md',
  );
  assert.match(attachment.content, /kind: "backlog-spec"/);
  assert.match(attachment.content, /roadmapItemId: "ri_123"/);
  assert.match(attachment.content, /# Mobile follow-up/);
});

test('roadmap promotion draft RPC params are typed', () => {
  const list = { itemId: 'ri_123' } satisfies RoadmapPromotionDraftListParams;
  const get = {
    path: '.roadmap/promotion-drafts/ri_123/01-mobile.md',
  } satisfies RoadmapPromotionDraftGetParams;
  const save = {
    path: get.path,
    content: '# Mobile\n',
    expectedHash: 'abc123',
  } satisfies RoadmapPromotionDraftSaveParams;

  assert.equal(list.itemId, 'ri_123');
  assert.equal(get.path, '.roadmap/promotion-drafts/ri_123/01-mobile.md');
  assert.equal(save.content, '# Mobile\n');
});

test('roadmap promote params support per-spec target projects', () => {
  const params = {
    itemId: 'ri_123',
    specs: [
      {
        project: 'metamask-mobile-farm',
        title: 'Mobile follow-up',
        body: '## Acceptance Criteria\n\n- Mobile is updated.',
      },
    ],
  } satisfies RoadmapPromoteParams;

  assert.equal(params.specs[0]?.project, 'metamask-mobile-farm');
});

test('roadmap item carries markdown location, tags, source, and promotion metadata', () => {
  const item = {
    id: 'ri_123',
    kind: 'roadmap-item',
    project: 'farmslot-farm',
    targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm'],
    title: 'Roadmap idea',
    stage: 'refined',
    tags: ['roadmap', 'command-center'],
    source: { kind: 'manual', ref: 'operator-note' },
    body: '## Problem\n\nDefine the idea.\n',
    promotion: [
      {
        backlogItemId: 'backlog-1',
        specPath: '.backlog/specs/roadmap-idea.md',
        project: 'metamask-mobile-farm',
        createdAt: '2026-06-28T00:00:00.000Z',
      },
    ],
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    filePath: '.roadmap/projects/farmslot-farm/items/2026-06-28-roadmap-idea.md',
    refinementPromptPath: '.roadmap/refinement-prompts/2026-ri-123-roadmap-idea.md',
    fileHash: 'abc123',
  } satisfies RoadmapItem;

  assert.deepEqual(item.tags, ['roadmap', 'command-center']);
  assert.deepEqual(item.targetProjects, ['metamask-mobile-farm', 'metamask-extension-farm']);
  assert.equal(
    item.refinementPromptPath,
    '.roadmap/refinement-prompts/2026-ri-123-roadmap-idea.md',
  );
  assert.equal(item.promotion?.[0]?.backlogItemId, 'backlog-1');
  assert.equal(item.promotion?.[0]?.project, 'metamask-mobile-farm');
});

test('roadmap refine params support runner and model overrides', () => {
  const params = {
    itemId: 'ri_123',
    runner: 'codex',
    model: 'gpt-5',
    runnerCommand: '{{runner}} --model {{model}} {{prompt_path}}',
    safetyTier: 'dangerous',
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
    tmuxTarget: '%3',
    tmuxWorker: {
      nodeId: 'macwork',
      session: 'roadmap-ri-123',
      window: '1',
      pane: '1',
      paneId: '%3',
      target: '%3',
    },
    launched: true,
    attachCommand: 'tmux attach -t roadmap-ri-123',
    runner: params.runner,
    model: params.model,
    runnerCommand: params.runnerCommand,
    safetyTier: params.safetyTier,
  } satisfies RoadmapRefineResult;

  assert.equal(result.runner, 'codex');
  assert.equal(result.model, 'gpt-5');
  assert.equal(result.safetyTier, 'dangerous');
});

test('roadmap refinement session status reports existing tmux target', () => {
  const params = { itemId: 'ri_123' } satisfies RoadmapRefinementSessionGetParams;
  const result = {
    itemId: params.itemId,
    tmuxSession: 'roadmap-ri-123',
    tmuxTarget: '%3',
    exists: true,
    tmuxWorker: {
      nodeId: 'macwork',
      session: 'roadmap-ri-123',
      window: '1',
      pane: '1',
      paneId: '%3',
      target: '%3',
    },
    attachCommand: "tmux attach -t '=roadmap-ri-123'",
  } satisfies RoadmapRefinementSessionGetResult;

  assert.equal(result.exists, true);
  assert.equal(result.tmuxWorker?.session, 'roadmap-ri-123');
});
