import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAllSchemas, SCHEMA_NAMES } from '../src/spec/schemas.js';
import { validateAgainstSchema } from '../src/validate/json-schema.js';

test('all eight spec schemas load as valid JSON with the right $id base', () => {
  const schemas = loadAllSchemas();
  assert.equal(SCHEMA_NAMES.length, 8);
  for (const name of SCHEMA_NAMES) {
    const schema = schemas[name];
    assert.ok(schema.$id?.startsWith('https://farmslot.dev/spec/learning-package/1/'), name);
    assert.equal(schema.type, 'object');
  }
});

test('validator honours the scrub-report if/then/else status co-constraint', () => {
  const schema = loadAllSchemas()['scrub-report'];
  const base = {
    schemaVersion: 1,
    scannedAt: '2026-07-03T15:45:00Z',
    floorVersion: 1,
    redactions: [],
    omitted: [],
    visualPassAttestations: [],
  };
  // pass with no blocked entries is valid.
  assert.equal(validateAgainstSchema({ ...base, status: 'pass', blocked: [] }, schema).length, 0);
  // pass WITH a blocked entry violates the else branch (maxItems 0).
  assert.ok(
    validateAgainstSchema(
      { ...base, status: 'pass', blocked: [{ file: 'x', kind: 'srp' }] },
      schema,
    ).length > 0,
  );
  // blocked with no entries violates the then branch (minItems 1).
  assert.ok(validateAgainstSchema({ ...base, status: 'blocked', blocked: [] }, schema).length > 0);
  // blocked WITH an entry is valid.
  assert.equal(
    validateAgainstSchema(
      { ...base, status: 'blocked', blocked: [{ file: 'x', kind: 'srp' }] },
      schema,
    ).length,
    0,
  );
});

test('validator honours the artifacts-index media if/then co-constraint', () => {
  const schema = loadAllSchemas()['artifacts-index'];
  const media = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    artifacts: [{ path: 'x.png', sha256: 'a'.repeat(64), kind: 'screenshot', ...extra }],
  });
  // screenshot missing the required media flags is rejected.
  assert.ok(validateAgainstSchema(media({}), schema).length > 0);
  // screenshot with the flags set false is rejected (must be const true).
  assert.ok(
    validateAgainstSchema(
      media({ evidenceManifestSelected: false, visualPassCleared: false }),
      schema,
    ).length > 0,
  );
  // screenshot with both flags true is accepted.
  assert.equal(
    validateAgainstSchema(
      media({ evidenceManifestSelected: true, visualPassCleared: true }),
      schema,
    ).length,
    0,
  );
  // a non-media artifact needs no media flags.
  assert.equal(
    validateAgainstSchema(
      {
        schemaVersion: 1,
        artifacts: [{ path: 'summary.json', sha256: 'a'.repeat(64), kind: 'summary' }],
      },
      schema,
    ).length,
    0,
  );
});

test('validator rejects additional properties on the closed manifest core', () => {
  const schema = loadAllSchemas().manifest;
  const errors = validateAgainstSchema(
    {
      schemaVersion: 1,
      packageId: '20260703T154211Z-fleet-dev-a1b2c3d4',
      surface: 'fleet',
      project: 'demo-farm',
      domain: '',
      engineer: 'eng-1',
      run: { startedAt: '2026-07-03T15:42:11Z', flow: 'dev', outcome: 'success' },
      task: { title: 'x', sourceKind: 'text' },
      files: {},
      scrubbing: { status: 'pass', scrubReport: 'scrub-report.json' },
      unexpectedTopLevel: true,
    },
    schema,
  );
  assert.ok(errors.some((e) => e.message.includes('unexpectedTopLevel')));
});
