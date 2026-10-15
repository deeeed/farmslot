import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { ArtifactRef } from '@farmslot/protocol';
import {
  isRecord,
  recipeTraceEntries,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';

import {
  dedupeWorkspaceEvidenceArtifacts,
  renderWorkspaceEvidencePreview,
} from './workspace-evidence-preview.js';

function artifact(path: string, overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return { path, purpose: 'screenshot', ...overrides };
}

function litText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(litText).join('');
  if (typeof value === 'object' && 'values' in value) {
    return (value as { values: unknown[] }).values.map(litText).join('');
  }
  return '';
}

test('dedupeWorkspaceEvidenceArtifacts collapses mirrored media by content hash', () => {
  const out = dedupeWorkspaceEvidenceArtifacts([
    artifact('artifacts/recipe-run/evidence-ac1.png', { sha256: 'same', sizeBytes: 10 }),
    artifact('artifacts/after-ac1.png', { sha256: 'same', sizeBytes: 10 }),
    artifact('artifacts/after.mp4', { sha256: 'video', purpose: 'video-after', sizeBytes: 20 }),
  ]);

  assert.deepEqual(
    out.map((entry) => entry.path),
    ['artifacts/recipe-run/evidence-ac1.png', 'artifacts/after.mp4'],
  );
});

test('dedupeWorkspaceEvidenceArtifacts preserves byte-identical before/after pairs', () => {
  const out = dedupeWorkspaceEvidenceArtifacts([
    artifact('artifacts/before.png', { sha256: 'same', purpose: 'screenshot-before' }),
    artifact('artifacts/after.png', { sha256: 'same', purpose: 'screenshot-after' }),
  ]);

  assert.deepEqual(
    out.map((entry) => entry.path),
    ['artifacts/before.png', 'artifacts/after.png'],
  );
});

test('dedupeWorkspaceEvidenceArtifacts keeps distinct same-name media without hashes', () => {
  const out = dedupeWorkspaceEvidenceArtifacts([
    artifact('artifacts/a/after.png', { sizeBytes: 10 }),
    artifact('artifacts/b/after.png', { sizeBytes: 10 }),
  ]);

  assert.deepEqual(
    out.map((entry) => entry.path),
    ['artifacts/a/after.png', 'artifacts/b/after.png'],
  );
});

test('renderWorkspaceEvidencePreview uses caller-supplied video action labels', () => {
  const rendered = renderWorkspaceEvidencePreview({
    title: 'Generated visual artifacts',
    items: [
      {
        artifact: artifact('artifacts/after.mp4', { purpose: 'video-after' }),
        url: '/artifacts/after.mp4',
        open: () => undefined,
        openLabel: 'Select preview',
      },
    ],
  });

  const text = litText(rendered);
  assert.match(text, /Select preview/);
  assert.doesNotMatch(text, /Open in lightbox/);
});

test('renderWorkspaceEvidencePreview discloses sliced preview overflow', () => {
  const rendered = renderWorkspaceEvidencePreview({
    title: 'Generated visual artifacts',
    totalCount: 3,
    overflowHint: '+1 more visual artifact in the full artifact grid below.',
    items: [
      { artifact: artifact('artifacts/one.png'), url: '/one.png' },
      { artifact: artifact('artifacts/two.png'), url: '/two.png' },
    ],
  });

  const text = litText(rendered);
  assert.match(text, /2 of 3/);
  assert.match(text, /\+1 more visual artifact/);
});

test('an unqualified capture keeps its original and limitation browsable', () => {
  const fixture: { input: RecordedEvidencePackageInput } = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const pkg = fixture.input;
  assert.ok(pkg.claims && isRecord(pkg.manifest) && Array.isArray(pkg.manifest.artifacts));
  const claim = pkg.claims.criteria.find((row) => row.id === 'check-1')!;
  const moment = claim.moments[0];
  assert.ok(moment);
  const index = moment.traceIndex;
  const trace = recipeTraceEntries(pkg.trace);
  assert.ok(trace);
  const node = trace[index];
  assert.ok(isRecord(node) && typeof node.nodeId === 'string');
  const still = pkg.manifest.artifacts.find(
    (entry) => isRecord(entry) && entry.type === 'screenshot',
  );
  assert.ok(isRecord(still));
  still.capture = {
    ac: claim.id,
    role: 'after',
    recipeRunId: pkg.claims.recipeRunId,
    traceIndex: index,
    nodeId: node.nodeId,
    sourceCommit: 'a'.repeat(40),
    sourceDirty: false,
  };
  const model = createEvidenceReviewModel({ package: pkg });
  const row = model.comparisons.find((row) => row.claim.id === claim.id)!;
  assert.equal(row.after.length, 1);
  assert.equal(row.selectedAfter, undefined);
  const text = litText(
    renderWorkspaceEvidencePreview({
      title: 'Evidence',
      items: [],
      comparison: {
        model,
        artifactUrl: (path) => path,
        openMedia() {},
        openMoment() {},
        changed() {},
      },
    }),
  );
  assert.ok(text.includes(row.after[0]!.name));
  assert.ok(text.includes(row.after[0]!.limitation!));
});

test('pending visual judgment controls render while evidence loads and after a read failure', () => {
  const input: RecordedEvidencePackageInput = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).input;
  for (const readErrors of [[], ['Evidence request timed out']]) {
    const model = createEvidenceReviewModel({ ledger: input.claims, readErrors });
    const text = litText(
      renderWorkspaceEvidencePreview({
        title: 'Evidence',
        items: [],
        comparison: {
          model,
          artifactUrl: (path) => path,
          openMedia() {},
          openMoment() {},
          changed() {},
        },
      }),
    );
    assert.match(text, /Confirm visual proof/);
    assert.match(text, /Reject visual proof/);
    assert.match(text, /check-1/);
  }
});
