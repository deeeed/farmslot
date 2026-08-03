import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRecipeUxCatalog } from './build-recipe-ux-catalog.mjs';
import { generateUxCatalog } from './generate-ux-catalog.mjs';

test('generates a compact index, annotated surface pages, and a portable source', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'farmslot-ux-board-'));
  try {
    await mkdir(path.join(outputDir, 'ios'));
    await mkdir(path.join(outputDir, 'android'));
    await writeFile(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        kind: 'visual-review-captures',
        capturedAt: '2026-08-03T00:00:00.000Z',
        variant: 'development',
        routes: [
          {
            id: 'capture-review',
            title: 'Review queue',
            nodeId: 'capture-review',
            proofTargets: ['ux-catalog'],
            images: { ios: 'ios/review.png', android: 'android/review.png' },
          },
          {
            id: 'capture-settings',
            title: 'Settings',
            nodeId: 'capture-settings',
            parentId: 'capture-review',
            relatedSurfaceIds: ['capture-review'],
            images: { ios: 'ios/settings.png' },
          },
        ],
      }),
    );
    await writeFile(path.join(outputDir, 'ios', 'review.png'), 'ios-review');
    await writeFile(path.join(outputDir, 'android', 'review.png'), 'android-review');
    await writeFile(path.join(outputDir, 'ios', 'settings.png'), 'ios-settings');

    generateUxCatalog(outputDir);

    const index = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    const review = await readFile(path.join(outputDir, 'screens', 'capture-review.html'), 'utf8');
    const settings = await readFile(
      path.join(outputDir, 'screens', 'capture-settings.html'),
      'utf8',
    );
    const source = JSON.parse(
      await readFile(path.join(outputDir, 'visual-review-source.json'), 'utf8'),
    );
    assert.match(index, /screens\/capture-review\.html#surface-capture-review/u);
    assert.match(index, /screens\/capture-settings\.html#surface-capture-settings/u);
    assert.match(index, /surface-tree--nested/u);
    assert.doesNotMatch(index, /<textarea/u);
    assert.match(review, /\.\.\/ios\/review\.png/u);
    assert.match(review, /\.\.\/android\/review\.png/u);
    assert.match(review, /data-surface-note="capture-review"/u);
    assert.match(review, /data-annotation-surface/u);
    assert.match(review, /data-capture-id="ios-capture-review"/u);
    assert.match(review, /capture-settings\.html#surface-capture-settings/u);
    assert.match(settings, /capture-review\.html#surface-capture-review/u);
    assert.match(settings, /Surface hierarchy/u);
    assert.doesNotMatch(settings, /<h2>Related<\/h2>/u);
    assert.match(settings, /data-annotation-mode="area"/u);
    assert.equal(existsSync(path.join(outputDir, 'assets', 'review-board.css')), true);
    assert.equal(existsSync(path.join(outputDir, 'assets', 'review-board.js')), true);
    assert.equal(source.kind, 'visual-review-source');
    assert.equal(source.surfaces[0].nodeId, 'capture-review');
    assert.deepEqual(source.surfaces[0].proofTargets, ['ux-catalog']);
    assert.equal(source.surfaces[1].parentId, 'capture-review');
    assert.deepEqual(source.surfaces[1].relatedSurfaceIds, ['capture-review']);

    generateUxCatalog(outputDir, { surfaceIds: ['capture-settings'] });
    const focusedIndex = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    assert.doesNotMatch(focusedIndex, /capture-review/u);
    assert.match(focusedIndex, /capture-settings/u);
    assert.equal(existsSync(path.join(outputDir, 'screens', 'capture-review.html')), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('derives review surfaces from recipe capture nodes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-recipe-board-'));
  const artifactsDir = path.join(root, 'artifacts');
  const outputDir = path.join(root, 'output');
  const recipePath = path.join(root, 'recipe.json');
  try {
    await mkdir(path.join(artifactsDir, 'ios'), { recursive: true });
    await writeFile(path.join(artifactsDir, 'ios', 'review.png'), 'review');
    await writeFile(path.join(artifactsDir, 'ios', 'detail.png'), 'detail');
    await writeFile(
      recipePath,
      JSON.stringify({
        title: 'Test catalog',
        workflow: {
          nodes: {
            'capture-review': {
              action: 'ui.capture_surface',
              path: '{{params.platform}}/review.png',
              label: 'Review queue',
              proves: ['review-proof'],
            },
            'capture-detail': {
              action: 'ui.screenshot',
              path: '{{params.platform}}/detail.png',
              label: 'Review detail',
              visual_review: { parent: 'capture-review', related: ['capture-review'] },
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      }),
    );

    buildRecipeUxCatalog({ artifactsDir, outputDir, platform: 'ios', recipePath });

    const source = JSON.parse(
      await readFile(path.join(outputDir, 'visual-review-source.json'), 'utf8'),
    );
    assert.equal(source.id, 'farmslot-farm:companion-ux-catalog');
    assert.equal(source.surfaces[0].id, 'capture-review');
    assert.equal(source.surfaces[0].captures[0].image.path, 'ios/review.png');
    assert.equal(source.surfaces[1].parentId, 'capture-review');
    assert.deepEqual(source.surfaces[1].relatedSurfaceIds, ['capture-review']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
