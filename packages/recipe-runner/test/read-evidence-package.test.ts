import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RecordedEvidencePackageInput } from '@farmslot/protocol';

import { readRecordedEvidencePackage, validateRecordedEvidencePackage } from '../src/index.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(
    new URL('../../../docs/examples/recipes/farmslot/artifacts/provenance-smoke/', import.meta.url),
    root,
    { recursive: true },
  );
  return root;
}

test('public reader supplies validator input and hashes retained bytes', async (t) => {
  const root = await fixture(t);
  const loaded = await readRecordedEvidencePackage(root);
  const input: RecordedEvidencePackageInput = loaded.input;
  assert.ok(loaded.checks.every((check) => check.status === 'pass'));
  const validation = validateRecordedEvidencePackage(input);
  assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
  assert.ok(validation.findings.some((finding) => /Legacy.*untimed/.test(finding.message)));
  const bytes = await readFile(path.join(root, 'trace.json'));
  assert.equal(
    input.artifactDigests['trace.json'],
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  );
  await writeFile(path.join(root, 'trace.json'), `${bytes.toString()}\n`);
  const changed = await readRecordedEvidencePackage(root);
  assert.notEqual(changed.input.artifactDigests['trace.json'], input.artifactDigests['trace.json']);
});

test('reader loads retained invocation, claims and declared timelines for the validator', async (t) => {
  const root = await fixture(t);
  const invocation = { recipeRunId: 'retained-run', claims: [] };
  const claims = { recording: { segments: [{ timelinePath: 'recording.json' }] } };
  const timeline = { markers: [] };
  for (const [file, value] of Object.entries({
    'recipe-invocation.json': invocation,
    'acceptance-status.json': claims,
    'recording.json': timeline,
  })) {
    await writeFile(path.join(root, file), JSON.stringify(value));
  }
  const loaded = await readRecordedEvidencePackage(root);
  assert.deepEqual(loaded.input.invocation, invocation);
  assert.deepEqual(loaded.input.claims, claims);
  assert.deepEqual(loaded.input.timelines['recording.json'], timeline);
  // Reading does not promote malformed claims into valid evidence.
  assert.equal(validateRecordedEvidencePackage(loaded.input).status, 'invalid');
  await rm(path.join(root, 'recording.json'));
  const missing = await readRecordedEvidencePackage(root);
  assert.ok(
    missing.checks.some((check) => check.id === 'file.recording.json' && check.status === 'fail'),
  );
});

test('malformed retained JSON remains a failed read check', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'acceptance-status.json'), '{');
  const loaded = await readRecordedEvidencePackage(root);
  assert.ok(
    loaded.checks.some(
      (check) => check.id === 'file.acceptance-status.json' && check.status === 'fail',
    ),
  );
});

test('a schema-1 task ledger in the package root is an explicit schema error', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'acceptance-status.json'),
    JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'The task check passes.',
          verdict: 'proven',
          evidence: ['artifacts/check.log'],
          recipeNodes: [],
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    }),
  );
  const loaded = await readRecordedEvidencePackage(root);
  assert(loaded.checks.every((check) => check.status === 'pass'));
  const result = validateRecordedEvidencePackage(loaded.input);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(
    result.findings.find((finding) => finding.path === 'acceptance-status.json.schemaVersion'),
    {
      severity: 'error',
      code: 'recorded_evidence.invalid',
      path: 'acceptance-status.json.schemaVersion',
      message:
        'Recipe claim packages require schema 2; a task acceptance ledger is not a recipe claim package.',
    },
  );
  // Even an empty schema-1 ledger must not silently pass the general validator.
  loaded.input.claims = JSON.parse('{"schemaVersion":1,"criteria":[]}');
  assert(
    validateRecordedEvidencePackage(loaded.input).findings.some(
      (finding) => finding.path === 'acceptance-status.json.schemaVersion',
    ),
  );
});

test('reader refuses linked files outside the retained package', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await rm(path.join(root, 'summary.json'));
  await symlink(path.join(outside, 'summary.json'), path.join(root, 'summary.json'));
  const loaded = await readRecordedEvidencePackage(root);
  assert.equal(loaded.input.summary, undefined);
  assert.equal(loaded.input.artifactDigests['summary.json'], undefined);
  for (const id of ['file.summary.json', 'digest.summary.json']) {
    assert.ok(loaded.checks.some((check) => check.id === id && check.status === 'fail'));
  }
});

test('host IO consumes the same closure and diagnostics without transferring original media', async (t) => {
  const root = await fixture(t);
  const original = await readRecordedEvidencePackage(root);
  const readPaths: string[] = [];
  const transported = await readRecordedEvidencePackage(root, {
    listPaths: async () => [...original.input.artifactPaths!],
    readJson: async (file) => {
      readPaths.push(file);
      return JSON.parse(await readFile(path.join(root, file), 'utf8'));
    },
    digestFile: async (file) => original.input.artifactDigests[file]!,
  });
  assert.deepEqual(transported, original);
  assert(readPaths.every((file) => file.endsWith('.json')));
});

test('task-root package consumes its indexed execution rather than unrelated gateway files', async (t) => {
  const root = await fixture(t);
  const original = await readRecordedEvidencePackage(root);
  for (const name of ['pr-package.json', 'pr-package.md', 'diff.txt', 'report.html'])
    await writeFile(path.join(root, name), 'unrelated task output');
  const prepared = await readRecordedEvidencePackage(root);
  assert.deepEqual(prepared, original);
  assert.equal(validateRecordedEvidencePackage(prepared.input).status, 'valid');
});
