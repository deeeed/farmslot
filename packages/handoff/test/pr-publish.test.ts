import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPrPackage } from '../src/pr-publish/build.js';
import { publishPrEvidence } from '../src/pr-publish/publish.js';

test('buildPrPackage is pure/local: composes title, report summary, and evidence block', () => {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'handoff-pr-'));
  writeFileSync(path.join(artifactsDir, 'report.md'), '# Report\n\nFixed the gate.\n');

  const result = buildPrPackage({
    title: 'fix: stabilize gate',
    artifactsDir,
    evidence: [{ path: 'harness/x/summary.json', description: 'run summary' }],
  });
  assert.ok(result.prDescriptionMarkdown.includes('fix: stabilize gate'));
  assert.ok(result.prDescriptionMarkdown.includes('Fixed the gate.'));
  assert.ok(result.evidenceMarkdown.includes('`harness/x/summary.json` - run summary'));
});

function packageDirWithIndex(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'handoff-pub-'));
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'artifacts/index.json'),
    JSON.stringify({
      schemaVersion: 1,
      artifacts: [{ path: 'harness/x/summary.json', sha256: 'a'.repeat(64), kind: 'summary' }],
    }),
  );
  return dir;
}

test('publishPrEvidence refuses without explicit per-call consent - even for dryRun', () => {
  const packageDir = packageDirWithIndex();
  for (const consent of [
    { githubWrite: false, publicUpload: true, grantedAt: '2026-07-13T10:00:00Z' },
    { githubWrite: true, publicUpload: false, grantedAt: '2026-07-13T10:00:00Z' },
  ]) {
    assert.throws(
      () => publishPrEvidence({ packageDir, consent, dryRun: true }),
      /explicit per-call consent/,
    );
  }
});

test('publishPrEvidence dryRun returns the upload plan with no writes', () => {
  const packageDir = packageDirWithIndex();
  const result = publishPrEvidence({
    packageDir,
    consent: { githubWrite: true, publicUpload: true, grantedAt: '2026-07-13T10:00:00Z' },
    dryRun: true,
  });
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(result.wouldUpload, ['harness/x/summary.json']);
  assert.equal(result.updatedPr, false);
});

test('the real publish transport is an honest not-implemented stub in v1', () => {
  const packageDir = packageDirWithIndex();
  assert.throws(
    () =>
      publishPrEvidence({
        packageDir,
        consent: { githubWrite: true, publicUpload: true, grantedAt: '2026-07-13T10:00:00Z' },
      }),
    /not implemented in v1/,
  );
});
