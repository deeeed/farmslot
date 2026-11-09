import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Text } from '@farmslot/agent-runtime';
import { type ArtifactRef, digestRecipeDocument, type EvidenceManifest } from '@farmslot/protocol';

import { observeProcessBaselines } from './process-baseline.js';

function fixture() {
  // A failed reproduction is still a baseline attempt. Its directory name has no phase meaning.
  const directory = 'artifacts/attempt-123';
  const invocation = { recipeRunId: 'reproduction', startedAt: '2026-11-08T01:00:00.000Z' };
  const files = new Map([
    [`${directory}/recipe-invocation.json`, JSON.stringify(invocation)],
    [
      `${directory}/summary.json`,
      JSON.stringify({
        ...invocation,
        status: 'fail',
        invocationDigest: digestRecipeDocument(invocation),
      }),
    ],
    [
      `${directory}/artifact-manifest.json`,
      JSON.stringify({
        version: 1,
        runStatus: 'fail',
        artifacts: [{ path: 'bug.png', type: 'screenshot' }],
      }),
    ],
  ]);
  const inventory: ArtifactRef[] = [...files].map(([path, bytes]) => ({
    path,
    purpose: 'other',
    sha256: sha256Text(bytes),
  }));
  const manifest: EvidenceManifest = {
    before_after_pairs: [
      { label: 'Bug reproduction', before: `${directory}/bug.png`, after: 'artifacts/fixed.png' },
    ],
  };
  return {
    files,
    inventory,
    manifest,
    contextId: 'worker',
    node: 'node',
    readText: async (file: string) => files.get(file) ?? null,
  };
}

test('a task-declared failed baseline retains digest-bound recipe timing', async () => {
  const result = await observeProcessBaselines(fixture());
  assert.equal(result.complete, true);
  assert.equal(result.first?.recipeRunId, 'reproduction');
  assert.equal(result.first?.at, '2026-11-08T01:00:00.000Z');
  assert.equal(result.sources.length, 3);
});

test('mutable recipe metadata and absent declarations never establish baseline coverage', async () => {
  const input = fixture();
  input.files.set(
    input.inventory[0].path,
    JSON.stringify({ recipeRunId: 'another', startedAt: '2026-11-08T00:00:00.000Z' }),
  );
  const changed = await observeProcessBaselines(input);
  assert.equal(changed.first, null);
  assert.equal(changed.complete, false);
  const undeclared = await observeProcessBaselines({ ...fixture(), manifest: undefined });
  assert.equal(undeclared.first, null);
  assert.equal(undeclared.complete, false);
});
