import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RECIPE_ACTION_MANIFEST_SCHEMA_URL, recipeTraceEntries } from '@farmslot/protocol';

import { createRecipeRunner } from '../src/core/runner.js';

for (const status of ['pass', 'fail'] as const) {
  for (const unavailable of [false, true]) {
    test(`HUD availability survives artifact publication without runner provenance: ${unavailable}/${status}`, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recipe-hud-availability-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const hud = { state: 'unavailable', reason: 'opaque-runtime' } as const;
      const runner = createRecipeRunner({
        actionManifest: {
          $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
          actions: {
            end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
          },
        },
        adapters: [],
        hud: false,
        defaultSource: { kind: 'operator', trust: 'trusted' },
      });
      const result = await runner.run({
        projectRoot: root,
        artifactsDir: path.join(root, 'artifacts'),
        recipeDocument: {
          $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
          title: 'HUD availability',
          description: 'Retain the host HUD availability without changing execution.',
          workflow: { entry: 'done', nodes: { done: { action: 'end', status } } },
        },
        ...(unavailable ? { hud } : {}),
      });
      assert.equal(result.status, status);
      const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
      const trace = JSON.parse(await fs.readFile(result.tracePath, 'utf8'));
      assert.deepEqual(summary.hud, unavailable ? hud : undefined);
      if (unavailable) {
        assert.deepEqual(trace.metadata.hud, hud);
        assert.equal(trace.metadata.runner, undefined);
      } else assert.equal(Array.isArray(trace), true, 'legacy trace remains an array');
      assert.equal(
        summary.total,
        recipeTraceEntries(trace)?.length,
        'availability is metadata, not an action',
      );
    });
  }
}
