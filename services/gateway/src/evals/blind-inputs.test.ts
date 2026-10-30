import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type EvalBlindTrial, evalComparisonEligibility } from '@farmslot/protocol';

import { buildSourceDiffFilter } from '../core/source-diff-filter.js';

import {
  assertBlindProblem,
  blindTrialEligibility,
  buildBlindInputAuditCommand,
  sourceComparisonDiff,
  stablePatchId,
} from './blind-inputs.js';

const patch = (file: string, value = 'fixed') =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${value}\n`;

test('reference patches use the same source filter and stable identity as candidate output', async () => {
  const filter = buildSourceDiffFilter();
  const candidate = patch('src/fee.ts');
  const reference = candidate + patch('yarn.lock');
  assert.equal(sourceComparisonDiff(reference, filter), candidate);
  assert.equal(
    await stablePatchId(sourceComparisonDiff(reference, filter)),
    await stablePatchId(candidate),
  );
  assert.equal(
    await stablePatchId(candidate.replace('+fixed', '+  fixed')),
    await stablePatchId(candidate),
  );
  assert.notEqual(
    await stablePatchId(patch('src/fee.ts', 'different')),
    await stablePatchId(candidate),
  );
  assert.equal(await stablePatchId(''), '');
  assert.throws(() => sourceComparisonDiff('# PR description', filter), /native reference/);
});

test('blind problem input rejects reference links, SHAs, manifests and patches', () => {
  const markers = ['#291', '77c08afb', '/gateway/experiment-manifest.json'];
  assert.equal(assertBlindProblem('Show the fee discount.', markers), 'Show the fee discount.');
  for (const problem of [
    undefined,
    'Replay #291',
    'Use 77C08AFB',
    '/gateway/experiment-manifest.json',
    patch('src/a.ts'),
  ])
    assert.throws(() => assertBlindProblem(problem, markers), /problem|reference material/);
});

test('legacy Markdown reference diffs explain how to recreate a blind experiment', () => {
  assert.throws(
    () =>
      sourceComparisonDiff(
        '# Reference diff\n\n```diff\n@@ -1 +1 @@\n-old\n+fixed\n```',
        buildSourceDiffFilter(),
      ),
    /Archive the existing experiment.*eval\.experiment\.create/,
  );
});

test('the task tree audit rejects nested answer files and reference content without printing it', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'inputs'));
  writeFileSync(path.join(root, 'TASK.md'), '# Ticket\nFix the discount.');
  const command = buildBlindInputAuditCommand(root, ['77c08afb', '#291']);
  assert.equal(JSON.parse(execFileSync('bash', ['-c', command], { encoding: 'utf8' })).clean, true);
  const assertRejected = () => {
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /secret reference text/);
  };
  writeFileSync(path.join(root, 'inputs', 'ordinary.md'), 'secret reference text 77c08afb');
  assertRejected();
  rmSync(path.join(root, 'inputs', 'ordinary.md'));
  writeFileSync(path.join(root, 'inputs', 'experiment-manifest.json'), '{}');
  assertRejected();
  rmSync(path.join(root, 'inputs', 'experiment-manifest.json'));
  symlinkSync('/not-read', path.join(root, 'inputs', 'link'));
  assertRejected();
});

test('only a verified, distinct first output can enter comparison; legacy output remains invalid', () => {
  const blind: EvalBlindTrial = {
    version: 1,
    baseSha: 'a'.repeat(40),
    problemDigest: 'problem',
    referenceCommits: ['b'.repeat(40)],
    referencePatchId: 'reference',
    forbiddenInputs: [],
    isolation: { slotId: 'owned', slotEpoch: 1, capsulePath: 'capsule', verifiedAt: 'now' },
    firstOutput: {
      headSha: 'c'.repeat(40),
      capturedAt: 'now',
      diffPath: 'first.diff',
      diffSha256: 'hash',
      patchId: 'reference',
      diff: {
        kind: 'contribution',
        source: 'artifact',
        available: true,
        files: 1,
        additions: 1,
        deletions: 1,
      },
    },
  };
  assert.equal(blindTrialEligibility(blind).status, 'contaminated');
  assert.equal(
    blindTrialEligibility({
      ...blind,
      firstOutput: { ...blind.firstOutput!, patchId: 'different' },
    }).status,
    'eligible',
  );
  assert.equal(
    blindTrialEligibility({ ...blind, invalidReason: 'Reference Git became available' }).status,
    'invalid',
  );
  assert.equal(blindTrialEligibility(undefined).status, 'invalid');
  assert.equal(evalComparisonEligibility({ role: 'candidate' }).status, 'invalid');
  assert.equal(evalComparisonEligibility({ role: 'reference' }).status, 'eligible');
});
