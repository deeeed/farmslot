import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRecipeUxCatalog } from './build-recipe-ux-catalog.mjs';

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
    assert.equal(source.surfaces[0].location, '/(tabs)/runs');
    assert.equal(source.surfaces[0].captures[0].image.path, 'ios/review.png');
    assert.equal(source.surfaces[1].parentId, 'capture-review');
    assert.deepEqual(source.surfaces[1].relatedSurfaceIds, ['capture-review']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog recipe indexes only artifacts produced by the recipe-derived builder', async () => {
  const recipe = JSON.parse(
    await readFile(
      new URL('../agentic/recipe/recipes/ux-catalog.recipe.json', import.meta.url),
      'utf8',
    ),
  );
  const indexedPaths = recipe.workflow.nodes['index-catalog'].artifacts.map(
    (artifact) => artifact.path,
  );

  assert.equal(indexedPaths.includes('.agent/ux-catalog-current/manifest.json'), false);
  assert.equal(indexedPaths.includes('.agent/ux-catalog-current/visual-review-source.json'), true);
});
