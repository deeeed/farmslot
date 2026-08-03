import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildRecipeReviewBoard,
  generateReviewBoard,
  serveReviewBoard,
} from '../visual-review/index.mjs';

const execFileAsync = promisify(execFile);

test('builds and serves a hierarchical visual review board on a dynamic port', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'farmslot-visual-review-'));
  let server;
  try {
    await writeFile(path.join(outputDir, 'overview.png'), 'overview');
    await writeFile(path.join(outputDir, 'detail.png'), 'detail');
    generateReviewBoard({
      outputDir,
      storageKey: 'visual-review-test',
      source: {
        version: 1,
        kind: 'visual-review-source',
        id: 'example-farm:ui-review',
        title: 'Example UI review',
        capturedAt: '2026-08-03T00:00:00.000Z',
        surfaces: [
          {
            id: 'overview',
            title: 'Overview',
            captures: [
              { id: 'web-overview', platform: 'web', image: { path: 'overview.png' } },
              { id: 'ios-overview', platform: 'ios', image: { path: 'overview.png' } },
            ],
          },
          {
            id: 'detail',
            title: 'Detail',
            location: '/detail/[id]',
            parentId: 'overview',
            relatedSurfaceIds: ['overview'],
            captures: [{ id: 'web-detail', platform: 'web', image: { path: 'detail.png' } }],
          },
          {
            id: 'subdetail',
            title: 'Subdetail',
            parentId: 'detail',
            captures: [{ id: 'ios-subdetail', platform: 'ios', image: { path: 'detail.png' } }],
          },
        ],
        navigationEdges: [{ fromSurfaceId: 'overview', toSurfaceId: 'detail', kind: 'push' }],
      },
      defaultPlatform: 'ios',
    });

    const index = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    const detail = await readFile(path.join(outputDir, 'screens', 'detail.html'), 'utf8');
    const client = await readFile(path.join(outputDir, 'assets', 'review-board.js'), 'utf8');
    assert.match(index, /surface-tree--nested/u);
    assert.match(index, /data-surface-depth="2"/u);
    assert.match(index, /data-surface-children="overview" hidden/u);
    assert.match(index, /data-surface-toggle="overview"/u);
    assert.match(index, /2 nested/u);
    assert.match(index, /Expand all/u);
    assert.match(index, /Collapse all/u);
    assert.match(index, /Navigation map/u);
    assert.match(index, /navigation-kind--push/u);
    assert.match(index, /data-default-platform="ios"/u);
    assert.match(index, /data-platform-filter="ios"/u);
    assert.match(index, /review-board\.js\?v=[a-f0-9]{16}/u);
    assert.match(detail, /Surface hierarchy/u);
    assert.match(detail, /data-capture-platform="web"/u);
    assert.match(detail, /data-platform-empty/u);
    assert.match(detail, /<span>Screen<\/span><strong>Detail<\/strong>/u);
    assert.match(detail, /Same screen/u);
    assert.match(detail, /Detail · Web/u);
    assert.match(index, />Compare platforms</u);
    assert.match(detail, /data-annotation-mode="area"/u);
    assert.match(detail, /draggable="false"/u);
    assert.match(client, /setPointerCapture/u);
    assert.match(client, /colorInput\.type = 'color'/u);
    assert.equal(client.includes('^annotation-(\\d+)$'), true);
    assert.match(client, /moveState/u);
    assert.match(client, /applyPlatformFilter/u);
    assert.match(client, /platformStorageKey/u);
    assert.match(client, /"kind":"visual-review-source"/u);
    assert.match(client, /"location":"\/detail\/\[id\]"/u);
    assert.match(client, /currentSurfaceIds\.has\(surfaceId\)/u);
    assert.match(client, /currentCaptureIds\.has/u);
    assert.match(client, /Runtime state may differ between capture sessions/u);
    assert.match(client, /platformComparison/u);
    const stylesheet = await readFile(path.join(outputDir, 'assets', 'review-board.css'), 'utf8');
    assert.match(stylesheet, /\.capture\[hidden\] \{ display: none; \}/u);
    assert.match(client, /setSurfaceExpanded/u);
    assert.match(client, /data-tree-action/u);

    server = await serveReviewBoard({ directory: outputDir });
    assert.notEqual(server.port, 0);
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Example UI review/u);
    assert.equal((await fetch(new URL('missing.html', server.url))).status, 404);
  } finally {
    if (server) await server.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('copies source images when building into another output directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-visual-review-cli-'));
  try {
    const sourceDir = path.join(root, 'source');
    const outputDir = path.join(root, 'output');
    await mkdir(path.join(sourceDir, 'ios'), { recursive: true });
    await writeFile(path.join(sourceDir, 'ios', 'screen.png'), 'screen');
    await writeFile(path.join(sourceDir, 'ios', 'detail.png'), 'detail');
    const sourcePath = path.join(sourceDir, 'visual-review-source.json');
    await writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        kind: 'visual-review-source',
        id: 'example:cli',
        title: 'CLI review',
        capturedAt: '2026-08-03T00:00:00.000Z',
        surfaces: [
          {
            id: 'screen',
            title: 'Screen',
            captures: [{ id: 'ios-screen', platform: 'ios', image: { path: 'ios/screen.png' } }],
          },
          {
            id: 'detail',
            title: 'Detail',
            parentId: 'screen',
            captures: [{ id: 'ios-detail', platform: 'ios', image: { path: 'ios/detail.png' } }],
          },
        ],
      }),
    );

    await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../bin/farmslot-visual-review.mjs', import.meta.url)),
      'build',
      sourcePath,
      '--output',
      outputDir,
      '--surface',
      'detail',
    ]);

    assert.equal(await readFile(path.join(outputDir, 'ios', 'detail.png'), 'utf8'), 'detail');
    const focusedSource = JSON.parse(
      await readFile(path.join(outputDir, 'visual-review-source.json'), 'utf8'),
    );
    assert.deepEqual(
      focusedSource.surfaces.map((surface) => surface.id),
      ['detail'],
    );
    assert.equal('parentId' in focusedSource.surfaces[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builds a project review board directly from recipe artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-recipe-review-'));
  const artifactsDir = path.join(root, 'artifacts');
  const outputDir = path.join(root, 'output');
  const recipePath = path.join(root, 'recipe.json');
  let server;
  try {
    await mkdir(path.join(artifactsDir, 'screens'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'screenshots'), { recursive: true });
    await writeFile(path.join(artifactsDir, 'screens', 'markets.png'), 'markets');
    await writeFile(path.join(artifactsDir, 'screens', 'detail.png'), 'detail');
    await writeFile(path.join(artifactsDir, 'screenshots', 'summary.png'), 'summary');
    await writeFile(
      recipePath,
      JSON.stringify({
        title: 'Perps surfaces',
        workflow: {
          nodes: {
            markets: {
              action: 'ui.capture_surface',
              path: 'screens/markets.png',
              label: 'Markets',
            },
            detail: {
              action: 'ui.screenshot',
              path: 'screens/detail.png',
              label: 'Market detail',
              visual_review: {
                parent: 'markets',
                navigation: [{ from: 'markets', kind: 'push' }],
              },
            },
            summary: {
              action: 'ui.capture_surface',
              label: 'Summary',
            },
          },
        },
      }),
    );

    const source = buildRecipeReviewBoard({
      artifactsDir,
      outputDir,
      platform: 'ios',
      recipePath,
      sourceId: 'metamask-mobile-farm:perps-surfaces',
      project: 'metamask-mobile-farm',
      runId: 'run-123',
      surfaceLocations: { detail: '/markets/[id]' },
    });

    assert.equal(source.id, 'metamask-mobile-farm:perps-surfaces');
    assert.equal(source.surfaces[1].parentId, 'markets');
    assert.deepEqual(source.navigationEdges, [
      { fromSurfaceId: 'markets', toSurfaceId: 'detail', kind: 'push' },
    ]);
    assert.equal(source.surfaces[1].captures[0].platform, 'ios');
    assert.equal(source.surfaces[1].location, '/markets/[id]');
    assert.equal(source.runId, 'run-123');
    const index = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    assert.match(index, /Perps surfaces/u);
    assert.match(index, /data-default-platform="ios"/u);
    assert.equal((await stat(path.join(outputDir, 'screens', 'markets.png'))).size, 7);
    assert.equal((await stat(path.join(outputDir, 'screens', 'detail.png'))).size, 6);
    assert.equal((await stat(path.join(outputDir, 'screenshots', 'summary.png'))).size, 7);
    server = await serveReviewBoard({ directory: outputDir });
    const imageResponse = await fetch(new URL('screens/markets.png', server.url));
    assert.equal(imageResponse.status, 200);
    assert.equal(await imageResponse.text(), 'markets');
  } finally {
    if (server) await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
