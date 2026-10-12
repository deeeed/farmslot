import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateRecipeAdapterAware } from '../src/harness/recipe-validation.js';

const manifest = JSON.parse(
  readFileSync(
    new URL('../../../docs/examples/recipes/farmslot-v1.action-manifest.json', import.meta.url),
    'utf8',
  ),
);

test('static validation checks each called log window with its actual parameters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'log-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'recipes'));
  await writeFile(
    path.join(root, 'recipes/watch.recipe.json'),
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      paramsSchema: {
        type: 'object',
        properties: {
          window: { type: 'integer', default: 0 },
          marker: { type: 'string', default: '' },
        },
        additionalProperties: false,
      },
      workflow: {
        entry: 'watch',
        nodes: {
          watch: {
            action: 'watch_logs',
            path: 'app.log',
            timeout_ms: '{{params.window}}',
            contains: '{{params.marker}}',
            intent: 'Observe readiness',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  );
  const librarySources = [{ name: 'logs', root }];
  for (const [params, expected] of [
    [{ window: 100 }, 'invalid'],
    [{ window: 60001, marker: 'ready' }, 'invalid'],
    [{ window: 100, marker: 'ready' }, 'valid'],
  ] as const) {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      workflow: {
        entry: 'call',
        nodes: {
          call: { action: 'call', ref: 'watch', params, intent: 'Check log', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    const result = await validateRecipeAdapterAware(
      'core',
      recipe,
      manifest,
      librarySources,
      undefined,
      {},
    );
    assert.equal(result.status, expected, JSON.stringify(result.findings));
  }
});
