import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRunsExportProfile, resolveRunsImportMode } from './runs-cli-options.js';

test('resolveRunsImportMode defaults to seed (writable sandbox copy)', () => {
  assert.equal(resolveRunsImportMode({}), 'seed');
});

test('resolveRunsImportMode maps human flags', () => {
  assert.equal(resolveRunsImportMode({ readOnly: true }), 'reference-only');
  assert.equal(resolveRunsImportMode({ keepIds: true }), 'mirror');
});

test('resolveRunsImportMode accepts legacy --mode for scripts', () => {
  assert.equal(resolveRunsImportMode({ mode: 'reference-only' }), 'reference-only');
});

test('resolveRunsImportMode rejects conflicting flags', () => {
  assert.throws(() => resolveRunsImportMode({ readOnly: true, keepIds: true }));
  assert.throws(() => resolveRunsImportMode({ mode: 'seed', readOnly: true }));
});

test('resolveRunsExportProfile defaults to reference', () => {
  assert.equal(resolveRunsExportProfile({}), 'reference');
});

test('resolveRunsExportProfile maps forensic and family-id', () => {
  assert.equal(resolveRunsExportProfile({ forensic: true }), 'full');
  assert.equal(resolveRunsExportProfile({ familyId: 'fam-1' }), 'family');
});

test('resolveRunsExportProfile rejects profile + forensic', () => {
  assert.throws(() => resolveRunsExportProfile({ profile: 'full', forensic: true }));
});
