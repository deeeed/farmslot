import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { benchDiffFiles, readEvalBenchComparison } from './bench-comparison.js';

const base = 'a'.repeat(40);
const patch =
  'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bench-compare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'trial-records'));
  await mkdir(path.join(root, 'refs'));
  await writeFile(path.join(root, 'refs/case-prereview.diff'), patch);
  for (const runId of [first, second]) {
    const record = {
      schema: 'bench-trial/1',
      runId,
      dataset: 'bench',
      task: {
        item: 'case',
        profile: 'fix-bug',
        area: 'Core',
        sizeClass: 'small',
        refRepo: 'owner/repo',
        refPr: 1,
      },
      arm: { model: 'Model', modelId: 'model', route: 'hosted', effort: 'high' },
      reference: { prereview: { base, head: 'b'.repeat(40) } },
      outcome: {
        vsPrereview: { verdict: 'MATCHES-REF', acsMet: '5/5' },
        findings: [
          {
            severity: 'minor',
            text: '<script>untrusted</script>',
            cause: 'model',
            sharedWithOriginal: false,
          },
        ],
        gate: 'n/a',
      },
      usage: { costUsd: null },
    };
    await writeFile(path.join(root, `trial-records/${runId}.json`), JSON.stringify(record));
    const dir = path.join(root, `workers/worker-${runId.slice(0, 8)}`);
    await mkdir(path.join(dir, 'task/artifacts'), { recursive: true });
    await writeFile(path.join(dir, 'diff-vs-base.patch'), patch.replace('+new', '+candidate'));
    await writeFile(path.join(dir, 'metrics.json'), JSON.stringify({ runId, blindBase: base }));
    await writeFile(
      path.join(dir, 'task/artifacts/acceptance-status.json'),
      JSON.stringify({
        schemaVersion: 2,
        criteria: [
          {
            id: 'AC-1',
            text: 'One generic criterion',
            verdict: 'proven',
            evidence: ['trace.json'],
          },
        ],
      }),
    );
  }
  await writeFile(
    path.join(root, 'trial-records/index.json'),
    JSON.stringify({
      schema: 'bench-trial-index/1',
      trials: [first, second].map((runId) => ({ runId, file: `trial-records/${runId}.json` })),
    }),
  );
  return root;
}

test('comparison retains both score bases, patch provenance and claim/ledger distinction', async (t) => {
  const root = await fixture(t);
  const value = await readEvalBenchComparison({ runIds: [first, second] }, root);
  assert.equal(value.trials.length, 2);
  assert.equal(value.trials[0].acClaim, '5/5');
  assert.equal(value.trials[0].criteria.length, 1);
  assert.match(value.trials[0].diffOfDiffs ?? '', /candidate/);
  assert.equal(value.trials[0].fileComparisons[0].path, 'src/example.ts');
  assert.match(value.trials[0].fileComparisons[0].diffOfDiffs ?? '', /candidate/);
  assert.equal(value.originalPatch.sha256?.length, 64);
  assert.equal(value.trials[0].findings[0].text, '<script>untrusted</script>');
  assert.deepEqual(
    benchDiffFiles(patch).map(({ text: _text, ...file }) => file),
    [{ path: 'src/example.ts', additions: 1, deletions: 1, kind: 'code' }],
  );
});

test('unknown or different bases never produce a diff-of-diffs; missing evidence stays missing', async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, 'workers/worker-11111111');
  await writeFile(path.join(dir, 'metrics.json'), JSON.stringify({ blindBase: 'c'.repeat(40) }));
  await rm(path.join(dir, 'task/artifacts/acceptance-status.json'));
  const value = await readEvalBenchComparison({ runIds: [first] }, root);
  assert.equal(value.trials[0].diffOfDiffs, null);
  assert(value.trials[0].fileComparisons.every((file) => file.diffOfDiffs === null));
  assert.match(value.trials[0].comparisonNote ?? '', /not verified equal/);
  assert.equal(value.trials[0].criteria.length, 0);
  assert.match(value.trials[0].coverageNote ?? '', /unavailable/);
  await assert.rejects(readEvalBenchComparison({ runIds: [first, first] }, root), /distinct/);
  await assert.rejects(
    readEvalBenchComparison({ runIds: ['absent'] }, root),
    /not in this benchmark/,
  );
});

test('malformed retained JSON and mismatched worker identity are refused without private snippets', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'workers/worker-11111111/metrics.json');
  await writeFile(file, '{"private-fragment-fixture": invalid');
  await assert.rejects(
    readEvalBenchComparison({ runIds: [first] }, root),
    (error) =>
      error instanceof Error &&
      !error.message.includes(root) &&
      !error.message.includes('private-fragment-fixture'),
  );
  await writeFile(file, JSON.stringify({ runId: second, blindBase: base }));
  await assert.rejects(readEvalBenchComparison({ runIds: [first] }, root), /different trial/);
});
