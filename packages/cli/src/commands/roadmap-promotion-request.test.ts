import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRoadmapPromotionRequest } from './roadmap-promotion-request.js';

test('createRoadmapPromotionRequest writes a file-backed decision', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-roadmap-promotion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const itemFile = '.roadmap/inbox/items/test.md';
  await mkdir(path.join(root, '.roadmap/inbox/items'), { recursive: true });
  await writeFile(
    path.join(root, itemFile),
    [
      '---',
      'id: "ri_test"',
      'kind: "roadmap-item"',
      'project: "global"',
      'targetProjects: ["metamask-mobile-farm","metamask-extension-farm"]',
      'title: "Test roadmap item"',
      'stage: "refined"',
      'tags: ["perps"]',
      'source: {"kind":"manual"}',
      'promotion: []',
      'createdAt: "2026-07-03T13:00:00.000Z"',
      'updatedAt: "2026-07-03T13:00:00.000Z"',
      '---',
      '',
      '## Backlog Drafts',
      '',
      '### Backlog Draft: Extension follow-up',
      '',
      'Project: `metamask-extension-farm`',
      '',
      '## Acceptance Criteria',
      '',
      '- Extension is updated.',
      '',
      '### Backlog Draft: Mobile follow-up',
      '',
      'Project: `metamask-mobile-farm`',
      '',
      '## Acceptance Criteria',
      '',
      '- Mobile is updated.',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = await createRoadmapPromotionRequest(
    root,
    {
      itemId: 'ri_test',
      itemFile,
      title: 'Test roadmap item',
      targetProjects: 'metamask-mobile-farm,metamask-extension-farm,metamask-mobile-farm',
      roadmapRoute: '#roadmap?item=ri_test',
    },
    new Date('2026-07-03T13:00:00.000Z'),
  );

  assert.equal(
    result.decisionPath,
    path.join(
      root,
      'projects/farmslot-farm/tasks/roadmap-promotion-ri_test/.pending_decision.json',
    ),
  );
  const raw = JSON.parse(await readFile(result.decisionPath, 'utf8'));
  assert.equal(raw.title, 'Review roadmap promotion (2 backlog items)');
  assert.equal(raw.context.kind, 'roadmap-promotion');
  assert.deepEqual(raw.context.targetProjects, ['metamask-mobile-farm', 'metamask-extension-farm']);
  assert.equal(raw.payload.kind, 'roadmap-promotion');
  assert.equal(raw.payload.expectedBacklogItems, 2);
  assert.equal(raw.payload.promotionRoute, '#roadmap?item=ri_test&promote=1');
  assert.deepEqual(raw.payload.draftSpecPaths, [
    '.roadmap/promotion-drafts/ri_test/01-metamask-extension-farm-extension-follow-up.md',
    '.roadmap/promotion-drafts/ri_test/02-metamask-mobile-farm-mobile-follow-up.md',
  ]);
  const extensionDraft = await readFile(path.join(root, raw.payload.draftSpecPaths[0]), 'utf8');
  assert.match(extensionDraft, /^---\nkind: "backlog-spec"/);
  assert.match(extensionDraft, /roadmapItemId: "ri_test"/);
  assert.match(extensionDraft, /project: "metamask-extension-farm"/);
  assert.match(extensionDraft, /# Extension follow-up/);
  assert.deepEqual(
    raw.actions.map((action: { id: string; style: string }) => ({
      id: action.id,
      style: action.style,
    })),
    [
      { id: 'review-promotion', style: 'primary' },
      { id: 'open-roadmap', style: 'secondary' },
      { id: 'revise-runner', style: 'secondary' },
      { id: 'dismiss', style: 'secondary' },
    ],
  );
  assert.equal(raw.created_at, '2026-07-03T13:00:00.000Z');
});

test('createRoadmapPromotionRequest rejects path traversal item ids before draft cleanup', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-roadmap-promotion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const itemFile = '.roadmap/inbox/items/test.md';
  await mkdir(path.join(root, '.roadmap/inbox/items'), { recursive: true });
  await writeFile(
    path.join(root, itemFile),
    [
      '---',
      'title: "Unsafe roadmap item"',
      '---',
      '',
      '## Backlog Drafts',
      '',
      '### Backlog Draft: Unsafe',
      '',
      'Project: `farmslot-farm`',
      '',
      '## Acceptance Criteria',
      '',
      '- Draft exists.',
      '',
    ].join('\n'),
    'utf8',
  );

  await assert.rejects(
    () =>
      createRoadmapPromotionRequest(root, {
        itemId: '../../..',
        itemFile,
        title: 'Unsafe roadmap item',
      }),
    /--item-id must be a safe path segment/,
  );
});
