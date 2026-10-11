import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RECIPE_PROTOCOL_SCHEMA_URL } from '@farmslot/protocol';

import { validateRecipeCliInput } from '../src/cli/support.js';
import { buildHudNode } from '../src/core/hud.js';

test('the recipe CLI exposes authoring warnings and errors at the 80/120 boundaries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-intent-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const length of [80, 81, 120, 121]) {
    const file = path.join(root, `${length}.json`);
    await writeFile(
      file,
      JSON.stringify({
        $schema: RECIPE_PROTOCOL_SCHEMA_URL,
        workflow: {
          entry: 'read',
          nodes: {
            read: { action: 'demo.read', intent: 'x'.repeat(length), next: 'done' },
            done: { action: 'end', status: 'pass' },
          },
        },
      }),
    );
    const result = await validateRecipeCliInput({ recipePath: file });
    const finding = result.findings.find((item) => item.code === 'workflow.intent_too_long');
    assert.equal(finding?.severity, length > 120 ? 'error' : length > 80 ? 'warning' : undefined);
    assert.equal(result.summary.errors, length > 120 ? 1 : 0);
  }
});

test('automatic HUD payload preserves long intent for the renderer instead of cutting it', () => {
  const intent = `Inspect ${'the full visible proof '.repeat(15)}and its final result.`;
  const hud = buildHudNode(
    'running',
    {
      nodeId: 'read',
      action: 'demo.read',
      node: { intent },
      recipe: {},
      index: 1,
      total: 1,
    },
    undefined,
  );
  assert.equal(hud.intent, intent);
  assert.equal(hud.text, intent);
});
