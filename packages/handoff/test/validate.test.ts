import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateLearningPackage } from '../src/validate/validate-package.js';

const PACKAGE_ID = '20260703T154211Z-fleet-dev-a1b2c3d4';

function writeJson(dir: string, rel: string, value: unknown): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
}

function buildValidPackage(
  overrides: {
    packageId?: string;
    scrubStatus?: 'pass' | 'blocked';
    artifacts?: unknown[];
    visualPassAttestations?: unknown[];
  } = {},
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'handoff-pkg-'));
  const packageId = overrides.packageId ?? PACKAGE_ID;
  const scrubStatus = overrides.scrubStatus ?? 'pass';

  writeFileSync(path.join(dir, 'task.md'), '# Task\n\nBody.\n');
  writeFileSync(path.join(dir, 'report.md'), '# Report\n\nDone.\n');
  writeFileSync(path.join(dir, 'learnings.md'), '# Learnings\n\nInsight.\n');
  writeJson(dir, 'source.json', { schemaVersion: 1, sourceKind: 'text' });
  writeJson(dir, 'provenance.json', { schemaVersion: 1, resolutions: [] });
  writeJson(dir, 'artifacts/index.json', {
    schemaVersion: 1,
    artifacts: overrides.artifacts ?? [],
  });
  writeJson(dir, 'scrub-report.json', {
    schemaVersion: 1,
    status: scrubStatus,
    scannedAt: '2026-07-03T15:45:00Z',
    floorVersion: 1,
    blocked: scrubStatus === 'blocked' ? [{ file: 'x', kind: 'srp' }] : [],
    redactions: [],
    omitted: [],
    visualPassAttestations: overrides.visualPassAttestations ?? [],
  });
  writeJson(dir, 'manifest.json', {
    schemaVersion: 1,
    packageId,
    surface: 'fleet',
    project: 'demo-farm',
    domain: '',
    engineer: 'eng-1',
    run: { startedAt: '2026-07-03T15:42:11Z', flow: 'dev', outcome: 'success' },
    task: { title: 'x', sourceKind: 'text' },
    files: {},
    scrubbing: { status: scrubStatus, scrubReport: 'scrub-report.json', floorVersion: 1 },
  });
  return dir;
}

test('a hand-built conformant package validates', () => {
  const dir = buildValidPackage();
  try {
    assert.deepEqual(validateLearningPackage(dir).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing required file is reported', () => {
  const dir = buildValidPackage();
  try {
    rmSync(path.join(dir, 'learnings.md'));
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('learnings.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a packageId that violates the run-slug grammar is rejected', () => {
  const dir = buildValidPackage({ packageId: 'not-a-valid-slug' });
  try {
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('run-slug')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a blocked scrub status makes the package invalid', () => {
  const dir = buildValidPackage({ scrubStatus: 'blocked' });
  try {
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("must be 'pass'")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a media artifact without a visual-pass attestation is rejected', () => {
  const dir = buildValidPackage({
    artifacts: [
      {
        path: 'harness/x/shot.png',
        sha256: 'a'.repeat(64),
        kind: 'screenshot',
        evidenceManifestSelected: true,
        visualPassCleared: true,
      },
    ],
    visualPassAttestations: [],
  });
  try {
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('visualPassAttestation')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a media artifact with a matching attestation validates', () => {
  const dir = buildValidPackage({
    artifacts: [
      {
        path: 'harness/x/shot.png',
        sha256: 'a'.repeat(64),
        kind: 'screenshot',
        evidenceManifestSelected: true,
        visualPassCleared: true,
      },
    ],
    visualPassAttestations: [
      {
        file: 'harness/x/shot.png',
        passedAt: '2026-07-03T15:45:00Z',
        attestedBy: 'agent-model',
        finding: 'clear',
      },
    ],
  });
  try {
    assert.deepEqual(validateLearningPackage(dir).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
