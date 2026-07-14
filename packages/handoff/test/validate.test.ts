import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildValidPackage(
  overrides: {
    packageId?: string;
    scrubStatus?: 'pass' | 'blocked';
    /** Real artifact files are written and inventoried; sha256 is computed. */
    artifacts?: { path: string; kind: string; [key: string]: unknown }[];
    visualPassAttestations?: unknown[];
  } = {},
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'handoff-pkg-'));
  const packageId = overrides.packageId ?? PACKAGE_ID;
  const scrubStatus = overrides.scrubStatus ?? 'pass';

  // Every written file lands in the manifest.files inventory with its real
  // hash (manifest.json aside), matching what the assembler produces.
  const files: Record<string, { sha256: string; role: string }> = {};
  const writeInventoried = (rel: string, content: string, role: string): void => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    files[rel] = { sha256: sha256Of(content), role };
  };

  writeInventoried('task.md', '# Task\n\nBody.\n', 'required');
  writeInventoried('report.md', '# Report\n\nDone.\n', 'required');
  writeInventoried('learnings.md', '# Learnings\n\nInsight.\n', 'required');
  writeInventoried(
    'source.json',
    `${JSON.stringify({ schemaVersion: 1, sourceKind: 'text' }, null, 2)}\n`,
    'required',
  );
  writeInventoried(
    'provenance.json',
    `${JSON.stringify({ schemaVersion: 1, resolutions: [] }, null, 2)}\n`,
    'required',
  );

  // Artifact records reference real, inventoried files with computed hashes.
  const artifactRecords = (overrides.artifacts ?? []).map((record) => {
    const content = `artifact bytes for ${record.path}\n`;
    writeInventoried(record.path, content, 'optional');
    return { ...record, sha256: sha256Of(content) };
  });
  writeInventoried(
    'artifacts/index.json',
    `${JSON.stringify({ schemaVersion: 1, artifacts: artifactRecords }, null, 2)}\n`,
    'required',
  );

  writeInventoried(
    'scrub-report.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: scrubStatus,
        scannedAt: '2026-07-03T15:45:00Z',
        floorVersion: 1,
        blocked: scrubStatus === 'blocked' ? [{ file: 'x', kind: 'srp' }] : [],
        redactions: [],
        omitted: [],
        visualPassAttestations: overrides.visualPassAttestations ?? [],
      },
      null,
      2,
    )}\n`,
    'required',
  );
  writeJson(dir, 'manifest.json', {
    schemaVersion: 1,
    packageId,
    taskKey: 'proj-1',
    surface: 'fleet',
    project: 'demo-farm',
    domain: '',
    engineer: 'eng-1',
    run: { startedAt: '2026-07-03T15:42:11Z', flow: 'dev', outcome: 'success' },
    task: { title: 'x', sourceKind: 'text' },
    files,
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

test('unknown files and directories are ignored without error (forward-compat)', () => {
  const dir = buildValidPackage();
  try {
    writeFileSync(path.join(dir, 'retrospective.md'), '# Retro\n');
    mkdirSync(path.join(dir, 'future-section'), { recursive: true });
    writeFileSync(path.join(dir, 'future-section/data.json'), '{"v":2}\n');
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

test('semantically impossible timestamps fail date-time validation', () => {
  const dir = buildValidPackage();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      run: { startedAt: string };
    };
    manifest.run.startedAt = '2026-99-99T99:99:99Z';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('startedAt')));
    // A real leap-day date still validates.
    manifest.run.startedAt = '2028-02-29T12:00:00Z';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(validateLearningPackage(dir).errors, []);
    // A non-leap-year Feb 29 does not.
    manifest.run.startedAt = '2026-02-29T12:00:00Z';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(validateLearningPackage(dir).valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the validator never reads outside the package dir: unsafe inventory keys are errors', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'handoff-outside-v-'));
  writeFileSync(path.join(outside, 'secret.md'), 'outside content\n');
  const dir = buildValidPackage();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, unknown>;
    };
    manifest.files[`../${path.basename(outside)}/secret.md`] = { sha256: 'a'.repeat(64) };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('unsafe inventory key')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory or unreadable target behind an inventory key is a collected error', () => {
  const dir = buildValidPackage();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, unknown>;
    };
    // 'artifacts' exists but is a DIRECTORY.
    manifest.files['artifacts'] = { sha256: 'a'.repeat(64) };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('is not a regular file')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fabricated or hash-inconsistent artifact records do not validate', () => {
  // Fabricated: record points at a file that is not in the inventory.
  const fabricated = buildValidPackage();
  try {
    const indexPath = path.join(fabricated, 'artifacts/index.json');
    writeFileSync(
      indexPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          artifacts: [{ path: 'harness/x/ghost.json', sha256: 'a'.repeat(64), kind: 'summary' }],
        },
        null,
        2,
      )}\n`,
    );
    const result = validateLearningPackage(fabricated);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('not in the manifest.files inventory')));
  } finally {
    rmSync(fabricated, { recursive: true, force: true });
  }

  // Hash mismatch: record disagrees with the inventory/on-disk hash.
  const mismatched = buildValidPackage({
    artifacts: [{ path: 'harness/x/summary.json', kind: 'summary' }],
  });
  try {
    const indexPath = path.join(mismatched, 'artifacts/index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      artifacts: { sha256: string }[];
    };
    index.artifacts[0].sha256 = 'b'.repeat(64);
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const result = validateLearningPackage(mismatched);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('sha256 disagrees')));
  } finally {
    rmSync(mismatched, { recursive: true, force: true });
  }
});

test('the validator is total: an unreadable required markdown is a collected error, not a throw', () => {
  const dir = buildValidPackage();
  try {
    chmodSync(path.join(dir, 'report.md'), 0o000);
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('report.md') && e.includes('unreadable')));
  } finally {
    chmodSync(path.join(dir, 'report.md'), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an included media file attested finding:"redacted" is invalid (spec 3.6)', () => {
  const dir = buildValidPackage({
    artifacts: [
      {
        path: 'harness/x/shot.png',
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
        finding: 'redacted',
      },
    ],
  });
  try {
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("must be attested 'clear'")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('taskKey format and ticket-correspondence are validated; hash form is producer-derived', () => {
  // Mismatch: ticket present but taskKey is a different well-formed key.
  const mismatched = buildValidPackage();
  try {
    const manifestPath = path.join(mismatched, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      taskKey: string;
      task: { ticket?: string };
    };
    manifest.task.ticket = 'PROJ-9';
    manifest.taskKey = 'other-key';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateLearningPackage(mismatched);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('does not correspond to ticket')));
  } finally {
    rmSync(mismatched, { recursive: true, force: true });
  }

  // Malformed shape: neither ticket form nor task-<16hex>.
  const malformed = buildValidPackage();
  try {
    const manifestPath = path.join(malformed, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { taskKey: string };
    manifest.taskKey = 'Not A Key!';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateLearningPackage(malformed);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('matches neither')));
  } finally {
    rmSync(malformed, { recursive: true, force: true });
  }

  // Well-formed content-hash key with no ticket: accepted as producer-derived.
  const hashKeyed = buildValidPackage();
  try {
    const manifestPath = path.join(hashKeyed, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { taskKey: string };
    manifest.taskKey = `task-${'ab12'.repeat(4)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(validateLearningPackage(hashKeyed).errors, []);
  } finally {
    rmSync(hashKeyed, { recursive: true, force: true });
  }
});

test('a required file missing from the manifest.files inventory is invalid', () => {
  const dir = buildValidPackage();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, unknown>;
    };
    delete manifest.files['learnings.md']; // file stays on disk, only the entry goes
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateLearningPackage(dir);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) =>
        e.includes("required file 'learnings.md' missing from the inventory"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RFC 3339-impossible offsets fail date-time validation; real offsets pass', () => {
  const dir = buildValidPackage();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      run: { startedAt: string };
    };
    const rewrite = (startedAt: string): void => {
      manifest.run.startedAt = startedAt;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };

    for (const bad of ['2026-07-13T10:00:00+99:99', '2026-07-13T10:00:00+24:00']) {
      rewrite(bad);
      const result = validateLearningPackage(dir);
      assert.equal(result.valid, false, `${bad} accepted`);
      assert.ok(result.errors.some((e) => e.includes('startedAt')));
    }
    for (const good of [
      '2026-07-13T10:00:00+09:00',
      '2026-07-13T10:00:00-05:30',
      '2026-07-13T10:00:00Z',
    ]) {
      rewrite(good);
      assert.deepEqual(validateLearningPackage(dir).errors, [], `${good} rejected`);
    }

    // The same format check guards optional content: graded_at with an
    // impossible offset invalidates grade.json.
    rewrite('2026-07-13T10:00:00Z');
    writeFileSync(
      path.join(dir, 'grade.json'),
      `${JSON.stringify(
        {
          recipe_semantic: 'good',
          reasoning: 'fine',
          graded_by: 'eng-1',
          graded_at: '2026-07-13T10:00:00+99:99',
        },
        null,
        2,
      )}\n`,
    );
    const withBadGrade = validateLearningPackage(dir);
    assert.equal(withBadGrade.valid, false);
    assert.ok(withBadGrade.errors.some((e) => e.includes('graded_at')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the taskKey shape is normative in the schemas, not only in the validator', () => {
  const dir = buildValidPackage();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { taskKey: string };
    const rewrite = (taskKey: string): void => {
      manifest.taskKey = taskKey;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };

    // Free-form keys are rejected at the SCHEMA level (pattern violation).
    rewrite('Not A Key!');
    const rejected = validateLearningPackage(dir);
    assert.equal(rejected.valid, false);
    assert.ok(rejected.errors.some((e) => e.includes('pattern')));

    // Both legitimate forms pass schema AND validator.
    rewrite('proj-1234');
    assert.deepEqual(validateLearningPackage(dir).errors, []);
    rewrite(`task-${'ab12'.repeat(4)}`);
    assert.deepEqual(validateLearningPackage(dir).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
