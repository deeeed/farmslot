import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoadmapItem } from '@farmslot/protocol';

import {
  filterRoadmapItemsByGlobalProjects,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
  sortRoadmapItems,
} from './roadmap-panel-model.js';

test('project filters keep unscoped global items visible', () => {
  const captured = {
    id: 'ri_global_capture',
    kind: 'roadmap-item',
    project: 'global',
    targetProjects: [],
    title: 'Coordinate framework work',
    stage: 'rough',
    source: { kind: 'manual' },
    body: 'Raw idea.\n',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    filePath: '.roadmap/items/ri_global_capture.md',
    fileHash: 'global-hash',
  } satisfies RoadmapItem;

  assert.deepEqual(filterRoadmapItemsByGlobalProjects([captured], ['farmslot-farm']), [captured]);
  assert.deepEqual(
    filterRoadmapItemsByGlobalProjects(
      [
        captured,
        {
          ...captured,
          id: 'ri_other',
          project: 'another-farm',
          title: 'Other work',
          filePath: '.roadmap/items/ri_other.md',
          fileHash: 'other-hash',
        },
      ],
      ['farmslot-farm', 'metamask-mobile-farm'],
    ),
    [captured],
  );
});

test('project filters only show targeted global items when a target matches', () => {
  const targeted = {
    id: 'ri_targeted_global',
    kind: 'roadmap-item',
    project: 'global',
    targetProjects: ['metamask-mobile-farm'],
    title: 'Mobile follow-up',
    stage: 'rough',
    source: { kind: 'manual' },
    body: 'Raw idea.\n',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    filePath: '.roadmap/items/ri_targeted_global.md',
    fileHash: 'targeted-hash',
  } satisfies RoadmapItem;

  assert.deepEqual(
    filterRoadmapItemsByGlobalProjects([targeted], ['farmslot-farm', 'audiolab-farm']),
    [],
  );
  assert.deepEqual(filterRoadmapItemsByGlobalProjects([targeted], ['metamask-mobile-farm']), [
    targeted,
  ]);
});

test('roadmap filtering preserves the item list when no global projects are active', () => {
  const items = [
    {
      id: 'ri_passthrough',
      kind: 'roadmap-item',
      project: 'farmslot-farm',
      title: 'Passthrough item',
      stage: 'rough',
      source: { kind: 'manual' },
      body: 'Raw idea.\n',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      filePath: '.roadmap/items/ri_passthrough.md',
      fileHash: 'passthrough-hash',
    },
  ] satisfies RoadmapItem[];

  assert.equal(filterRoadmapItemsByGlobalProjects(items, []), items);
});

test('sortRoadmapItems supports stable inventory columns', () => {
  const base = {
    kind: 'roadmap-item',
    project: 'zeta-farm',
    title: 'Zeta',
    stage: 'rough',
    source: { kind: 'manual' },
    body: 'Idea.\n',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    filePath: '.roadmap/items/ri_zeta.md',
    fileHash: 'zeta-hash',
  } satisfies Omit<RoadmapItem, 'id'>;
  const zeta = { ...base, id: 'ri_zeta' } satisfies RoadmapItem;
  const alpha = {
    ...base,
    id: 'ri_alpha',
    project: 'alpha-farm',
    title: 'Alpha',
    stage: 'promoted',
    updatedAt: '2026-07-29T00:00:00.000Z',
    promotion: [{ backlogItemId: 'bl_alpha', createdAt: '2026-07-29T00:00:00.000Z' }],
  } satisfies RoadmapItem;

  assert.deepEqual(
    sortRoadmapItems([zeta, alpha], 'project', 'asc').map((item) => item.id),
    ['ri_alpha', 'ri_zeta'],
  );
  assert.deepEqual(
    sortRoadmapItems([zeta, alpha], 'updated', 'desc').map((item) => item.id),
    ['ri_alpha', 'ri_zeta'],
  );
});

test('project filters keep unassigned items hidden until they are scoped', () => {
  const unassigned = {
    id: 'ri_unassigned',
    kind: 'roadmap-item',
    project: 'unassigned',
    targetProjects: [],
    title: 'Unassigned item',
    stage: 'rough',
    source: { kind: 'manual' },
    body: 'Raw idea.\n',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    filePath: '.roadmap/items/ri_unassigned.md',
    fileHash: 'unassigned-hash',
  } satisfies RoadmapItem;

  assert.deepEqual(filterRoadmapItemsByGlobalProjects([unassigned], ['farmslot-farm']), []);
});

test('roadmap promotion parser extracts generated backlog drafts', () => {
  const drafts = parsePromotionDraftsFromRoadmapBody(
    [
      '## Problem',
      '',
      'Client follow-up is needed.',
      '',
      '## Backlog Drafts',
      '',
      '### Backlog Draft: Consume controller contract in Extension',
      '',
      'Project: `metamask-extension-farm`',
      'Tags: `analytics`, `perps`',
      '',
      '#### Implementation Notes',
      '',
      '- Update the package.',
      '',
      '## Acceptance Criteria',
      '',
      '- Extension uses controller exports.',
      '',
      '### Backlog Draft: Consume controller contract in Mobile',
      '',
      'Project: `metamask-mobile-farm`',
      '',
      '#### Implementation Notes',
      '',
      '- Update the package.',
      '',
      '## Acceptance Criteria',
      '',
      '- Mobile uses controller exports.',
      '',
      '## Reference Verification',
      '',
      '- Verified PR context.',
    ].join('\n'),
  );

  assert.equal(drafts.length, 2);
  assert.deepEqual(
    drafts.map((draft) => draft.project),
    ['metamask-extension-farm', 'metamask-mobile-farm'],
  );
  assert.equal(drafts[0]?.title, 'Consume controller contract in Extension');
  assert.match(drafts[0]?.body ?? '', /Extension uses controller exports/);
  assert.equal(drafts[1]?.title, 'Consume controller contract in Mobile');
  assert.match(drafts[1]?.body ?? '', /Mobile uses controller exports/);
  assert.doesNotMatch(drafts[1]?.body ?? '', /Reference Verification/);
});

test('roadmap promotion parser returns no drafts without a backlog drafts section', () => {
  assert.deepEqual(parsePromotionDraftsFromRoadmapBody('## Problem\n\nOnly roadmap notes.'), []);
});

test('roadmap promotion attachment renders backlog spec shaped markdown', () => {
  const attachment = promotionDraftAttachment(
    {
      id: 'ri_demo',
      title: 'Demo roadmap',
      tags: ['perps'],
    },
    {
      project: 'metamask-mobile-farm',
      title: 'Consume controller analytics',
      body: '## Acceptance Criteria\n\n- Mobile uses controller exports.',
    },
    0,
  );

  assert.equal(attachment.filename, '01-metamask-mobile-farm-consume-controller-analytics.md');
  assert.equal(
    attachment.virtualPath,
    '.roadmap/promotion-drafts/ri_demo/01-metamask-mobile-farm-consume-controller-analytics.md',
  );
  assert.match(attachment.content, /^---\nkind: "backlog-spec"/);
  assert.match(attachment.content, /roadmapItemId: "ri_demo"/);
  assert.match(attachment.content, /project: "metamask-mobile-farm"/);
  assert.match(attachment.content, /# Consume controller analytics/);
});
