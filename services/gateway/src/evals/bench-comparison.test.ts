import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { benchDiffFiles } from '@farmslot/protocol';

import { readEvalBenchComparison } from './bench-comparison.js';

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
  await writeFile(
    path.join(dir, 'metrics.json'),
    JSON.stringify({ runId: first, blindBase: 'c'.repeat(40) }),
  );
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

test('missing worker identity withholds patch, ledger and scope attribution', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'workers/worker-11111111/metrics.json');
  for (const metrics of [null, { blindBase: base }]) {
    if (metrics === null) await rm(file);
    else await writeFile(file, JSON.stringify(metrics));
    const detail = (await readEvalBenchComparison({ runIds: [first] }, root)).trials[0];
    assert.equal(detail.patch.text, null);
    assert.equal(detail.patch.sha256, null);
    assert.deepEqual(detail.patch.files, []);
    assert.equal(detail.patch.totals, null);
    assert.match(detail.patch.missingReason ?? '', /identity unverified/i);
    assert.deepEqual(detail.criteria, []);
    assert.match(detail.coverageNote ?? '', /identity unverified/i);
    assert.deepEqual(detail.extraFiles, []);
    assert.deepEqual(detail.missingFiles, []);
  }
});

test('base verification requires full SHA equality, ignoring hex case only', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, `trial-records/${first}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  for (const refBase of [base.slice(0, 7), base.slice(0, 10), base.toUpperCase()]) {
    record.reference.prereview.base = refBase;
    await writeFile(file, JSON.stringify(record));
    const detail = (await readEvalBenchComparison({ runIds: [first] }, root)).trials[0];
    if (refBase.length === 40) assert.notEqual(detail.diffOfDiffs, null);
    else {
      assert.equal(detail.diffOfDiffs, null);
      assert(detail.fileComparisons.every((f) => f.diffOfDiffs === null));
      assert.match(detail.comparisonNote ?? '', /not verified equal/);
    }
  }
});

test('large unrelated patches yield to timers and leave an explicit bounded-comparison note', async (t) => {
  const root = await fixture(t);
  const largePatch = (label: string) =>
    'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n' +
    '@@ -0,0 +1,4000 @@\n' +
    Array.from({ length: 4000 }, (_, i) => `+${label}-${i}\n`).join('');
  await writeFile(path.join(root, 'refs/case-prereview.diff'), largePatch('original'));
  await writeFile(
    path.join(root, 'workers/worker-11111111/diff-vs-base.patch'),
    largePatch('candidate'),
  );
  let previous = performance.now();
  let maxTimerGapMs = 0;
  const tick = () => {
    const now = performance.now();
    maxTimerGapMs = Math.max(maxTimerGapMs, now - previous);
    previous = now;
  };
  const interval = setInterval(tick, 10);
  t.after(() => clearInterval(interval));
  const start = performance.now();
  const detail = (await readEvalBenchComparison({ runIds: [first] }, root)).trials[0];
  tick();
  t.diagnostic(JSON.stringify({ elapsedMs: performance.now() - start, maxTimerGapMs }));
  assert(maxTimerGapMs < 1000, `Gateway timers blocked for ${maxTimerGapMs}ms`);
  assert.equal(detail.diffOfDiffs, null);
  assert.match(detail.comparisonNote ?? '', /budget/i);
  assert(
    detail.fileComparisons.every((f) => f.diffOfDiffs === null && /budget/i.test(f.note ?? '')),
  );
});
