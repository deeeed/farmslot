import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

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
