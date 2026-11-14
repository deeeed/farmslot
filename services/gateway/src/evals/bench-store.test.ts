import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseBenchTrial, readEvalBench } from './bench-store.js';

const usage = { costUsd: 1, turns: 3 };
function fixture() {
  return {
    schema: 'bench-trial/1',
    runId: 'run',
    dataset: 'bench',
    task: {
      item: 'case',
      profile: 'fix-bug',
      area: 'Core',
      sizeClass: 'small',
      refRepo: 'owner/repo',
      refPr: 1,
    },
    arm: { model: 'Model', modelId: 'model', effort: 'high', route: 'hosted' },
    reference: { prereview: { base: 'base', head: 'head' } },
    outcome: {
      vsPrereview: { verdict: 'ACCEPTABLE-ALT', mergeable: 'no' },
      vsMerged: { verdict: 'PARTIAL' },
    },
    usage,
  };
}

test('original verdict never falls back to the merged score or leaks raw record fields', () => {
  const value = fixture();
  const result = parseBenchTrial({ ...value, safety: { credentialValues: ['private'] } }, 'hash');
  assert.equal(result.verdict, 'ACCEPTABLE-ALT');
  assert.equal(result.verdictVsMerged, 'PARTIAL');
  assert.equal(result.original, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(
    parseBenchTrial({ ...value, outcome: { vsMerged: { verdict: 'MATCHES-REF' } } }, 'hash')
      .verdict,
    null,
  );
  assert.throws(() => parseBenchTrial({ ...value, usage: { costUsd: -1 } }, 'hash'));
});

test('configured index reads actual records, refreshes edits and rejects escaping paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-bench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'trial-records'));
  const row = { runId: 'run', file: 'trial-records/run.json' };
  const writeIndex = (file: string) =>
    writeFile(
      path.join(root, 'trial-records/index.json'),
      JSON.stringify({ schema: 'bench-trial-index/1', trials: [{ ...row, file }] }),
    );
  await writeIndex(row.file);
  const file = path.join(root, row.file);
  await writeFile(file, JSON.stringify(fixture()));
  const result = await readEvalBench(root);
  assert.equal(result.rollups[0].solved, 1);
  await writeFile(file, JSON.stringify({ ...fixture(), outcome: { unscored: 'policy-cancel' } }));
  assert.equal((await readEvalBench(root)).rollups[0].unscored, 1);
  await writeIndex('../outside.json');
  await assert.rejects(readEvalBench(root));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'eval-bench-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'record.json'), JSON.stringify(fixture()));
  await symlink(outside, path.join(root, 'outside'));
  await writeIndex('outside/record.json');
  await assert.rejects(readEvalBench(root));
});

test('original usage joins only the pinned repository/head and supplies measured saving inputs', () => {
  const receipt = {
    repo: 'owner/repo',
    head: 'head',
    runId: 'original-run',
    model: 'Original',
    scope: 'initial worker',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T01:00:00Z',
    sourceSha256: 'source-hash',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: null,
      costUsd: 10,
      costNote: null,
      turns: 50,
      wallMinutes: 60,
    },
  };
  assert.equal(parseBenchTrial(fixture(), 'hash', [receipt]).original?.usage.costUsd, 10);
  assert.equal(
    parseBenchTrial(fixture(), 'hash', [{ ...receipt, head: 'later-merged-head' }]).original,
    null,
  );
  assert.throws(() => parseBenchTrial(fixture(), 'hash', [receipt, receipt]), /Ambiguous/);
});
