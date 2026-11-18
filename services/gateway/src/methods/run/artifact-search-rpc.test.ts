import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { RunArtifactBundleRef } from '@farmslot/protocol';

import { makeRun } from './test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-search-rpc-test-'));
after(() => rm(root, { recursive: true, force: true }));
const file = path.join(root, 'report.log');
const text = 'header\nneedle in original content\n';
await writeFile(file, text);
const sha256 = createHash('sha256').update(text).digest('hex');
const ref: RunArtifactBundleRef = {
  storeId: 'store',
  bundleDigest: 'bundle',
  taskKey: 'task',
  manifestDigest: 'manifest',
};
const run = makeRun({ id: 'owned' });
const selections: Array<Record<string, string>> = [];
let changed = false;
mock.module('../../runs/store.js', {
  namedExports: { getRun: (id: string) => (id === 'owned' ? run : undefined) },
});
mock.module('../filesystem.js', {
  namedExports: {
    retainedRunArtifactRef: async () => ref,
    resolveRetainedRunArtifact: async (
      _run: unknown,
      requested: string,
      selectors: URLSearchParams,
    ) => {
      selections.push(Object.fromEntries(selectors));
      if (requested.includes('..')) throw Object.assign(Error('outside'), { code: 'EACCES' });
      return {
        ref,
        entry: {
          path: file,
          bytes: Buffer.byteLength(text),
          sha256: changed ? '0'.repeat(64) : sha256,
        },
      };
    },
  },
});
const { runSearchArtifacts } = await import('./artifact-search-rpc.js');

test('RPC binds original artifact selectors and verifies the exact retained bytes', async () => {
  const result = await runSearchArtifacts({
    runId: 'owned',
    query: 'needle',
    paths: ['artifacts/report.log'],
    bundleDigest: 'bundle',
    recipeRunId: 'recipe',
    decisionId: 'decision',
    versions: { 'artifacts/report.log': sha256 },
  });
  assert.equal(result.files[0].hits[0].line, 2);
  assert.equal(result.files[0].sha256, sha256);
  assert.deepEqual(selections.at(-1), {
    bundleDigest: 'bundle',
    recipeRunId: 'recipe',
    decisionId: 'decision',
    v: sha256,
  });
});

test('changed or escaped retained files never produce a content hit', async () => {
  changed = true;
  try {
    const result = await runSearchArtifacts({
      runId: 'owned',
      query: 'needle',
      paths: ['artifacts/report.log', '../../outside.log'],
    });
    assert.deepEqual(result.files, []);
    assert.equal(result.skippedFiles, 2);
    assert(result.partial);
  } finally {
    changed = false;
  }
});

test('invalid RPC inputs fail before resolving retained files', async () => {
  const before = selections.length;
  // @ts-expect-error query must be a string at the RPC boundary.
  await assert.rejects(runSearchArtifacts({ runId: 'owned', query: 3, paths: [] }), /Invalid/);
  await assert.rejects(
    runSearchArtifacts({
      runId: 'owned',
      query: 'needle',
      paths: Array.from({ length: 501 }, () => file),
    }),
    /Invalid/,
  );
  assert.equal(selections.length, before);
});
