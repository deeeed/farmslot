import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

import { resolveSelectedEvidenceRef } from './evidence-paths.js';
import {
  assertPublicationEvidenceSelection,
  defaultSelectedEvidenceKeysForPublication,
} from './publication-evidence-policy.js';

const inventory: ArtifactRef[] = [
  { path: 'artifacts/recipe-run/screenshots/before.png', purpose: 'screenshot' },
  { path: 'artifacts/recipe-run/screenshots/after.png', purpose: 'screenshot' },
  { path: 'artifacts/after.mp4', purpose: 'video-after' },
];
const manifest = {
  preferred_mode: 'screenshots' as const,
  before_after_pairs: [
    {
      label: 'Transition',
      before: 'recipe-run/screenshots/before.png',
      after: 'recipe-run/screenshots/after.png',
    },
  ],
  videos: { after: 'after.mp4', preferred: false },
};

test('publication refuses an empty selection and video-only selection for screenshot evidence', () => {
  assert.throws(
    () =>
      assertPublicationEvidenceSelection({
        selectedEvidenceKeys: [],
        evidenceManifest: inventory,
        trustedEvidenceManifest: manifest,
      }),
    /visual evidence is required/,
  );
  assert.throws(
    () =>
      assertPublicationEvidenceSelection({
        selectedEvidenceKeys: ['artifacts/after.mp4'],
        evidenceManifest: inventory,
        trustedEvidenceManifest: manifest,
      }),
    /requires screenshots/,
  );
  assert.throws(
    () =>
      assertPublicationEvidenceSelection({
        selectedEvidenceKeys: [],
        evidenceManifest: [],
        trustedEvidenceManifest: manifest,
      }),
    /visual evidence is required/,
  );
  assert.deepEqual(
    assertPublicationEvidenceSelection({
      selectedEvidenceKeys: [],
      evidenceManifest: [],
      trustedEvidenceManifest: null,
    }),
    [],
  );
});

test('curated screenshots and an explicitly selected nonpreferred video remain publishable', () => {
  assert.deepEqual(
    assertPublicationEvidenceSelection({
      selectedEvidenceKeys: inventory.map((entry) => entry.path),
      evidenceManifest: inventory,
      trustedEvidenceManifest: manifest,
    }),
    inventory.map((entry) => entry.path).sort(),
  );
  assert.deepEqual(
    defaultSelectedEvidenceKeysForPublication({
      evidenceManifest: inventory,
      trustedEvidenceManifest: manifest,
    }),
    inventory
      .slice(0, 2)
      .map((entry) => entry.path)
      .sort(),
  );
  assert.deepEqual(
    defaultSelectedEvidenceKeysForPublication({
      evidenceManifest: [inventory[2]],
      trustedEvidenceManifest: { preferred_mode: 'video', videos: { after: 'after.mp4' } },
    }),
    ['artifacts/after.mp4'],
  );
});

test('qualified evidence paths retain scope with optional artifacts prefix while bare names stay unambiguous', () => {
  const duplicate = { path: 'artifacts/old/screenshots/before.png', purpose: 'screenshot' };
  assert.equal(
    resolveSelectedEvidenceRef('recipe-run/screenshots/before.png', [duplicate, ...inventory])
      ?.path,
    inventory[0].path,
  );
  assert.equal(
    resolveSelectedEvidenceRef('unlisted/screenshots/before.png', [duplicate, ...inventory]),
    null,
  );
  assert.throws(
    () => resolveSelectedEvidenceRef('before.png', [duplicate, ...inventory]),
    /ambiguous/,
  );
  assert.equal(resolveSelectedEvidenceRef('before.png', [inventory[0]])?.path, inventory[0].path);
});
