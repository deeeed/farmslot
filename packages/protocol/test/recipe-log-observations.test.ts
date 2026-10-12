import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  validateRecipeWithManifest,
  validateResolvedRecipeActionNode,
} from '../src/recipe/document.js';

const manifest = JSON.parse(
  readFileSync(
    new URL('../../../docs/examples/recipes/farmslot-v1.action-manifest.json', import.meta.url),
    'utf8',
  ),
);

function recipe(fields: Record<string, unknown>) {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    workflow: {
      entry: 'watch',
      nodes: {
        watch: {
          action: 'watch_logs',
          path: 'app.log',
          intent: 'Observe readiness',
          next: 'done',
          ...fields,
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

test('log windows validate bounds and condition before execution', () => {
  for (const timeout_ms of [-1, 1.5, 60001, null, '100']) {
    assert.equal(
      validateRecipeWithManifest(recipe({ timeout_ms, contains: 'ready' }), manifest).status,
      'invalid',
    );
  }
  for (const fields of [{ timeout_ms: 100 }, { timeout_ms: 100, contains: '' }]) {
    assert.equal(validateRecipeWithManifest(recipe(fields), manifest).status, 'invalid');
  }
  for (const fields of [{}, { timeout_ms: 0 }, { timeout_ms: 60000, contains: 'ready' }]) {
    const result = validateRecipeWithManifest(recipe(fields), manifest);
    assert.equal(result.status, 'valid', JSON.stringify(result.findings));
  }
});

test('known output-derived paths need explicit file scope', () => {
  for (const path of ['{{outputs.read.path}}', 'logs/{{outputs.read.name}}.log']) {
    assert.equal(validateRecipeWithManifest(recipe({ path }), manifest).status, 'invalid');
    assert.equal(
      validateRecipeWithManifest(recipe({ path, scope: 'file' }), manifest).status,
      'valid',
    );
  }
});

test('preflight defers output values but resolved validation remains strict', () => {
  const node = {
    action: 'watch_logs',
    path: '{{params.log}}',
    timeout_ms: '{{outputs.read.window}}',
    contains: '{{outputs.read.marker}}',
  };
  assert.equal(
    validateResolvedRecipeActionNode(node, manifest, { allowTemplates: true }).status,
    'valid',
  );
  assert.equal(validateResolvedRecipeActionNode(node, manifest).status, 'invalid');
  assert.equal(
    validateResolvedRecipeActionNode(
      { ...node, path: 'app.log', timeout_ms: 100, contains: '' },
      manifest,
    ).status,
    'invalid',
  );
});
