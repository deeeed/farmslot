import path from 'node:path';

import type { ArtifactRef } from '@farmslot/protocol';

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm']);

export function isUploadableMediaPath(file: string): boolean {
  const withoutQuery = file.split(/[?#]/, 1)[0] ?? file;
  return MEDIA_EXTENSIONS.has(path.extname(withoutQuery).toLowerCase());
}

function normalizeEvidenceKey(key: string): string {
  return key.replace(/\\/g, '/').replace(/^\.?\//, '');
}

/** A manifest path names one artifact, with or without the task artifacts prefix. */
export function exactEvidenceKeys(key: string): string[] {
  const relative = normalizeEvidenceKey(key).replace(/^artifacts\//, '');
  return [relative, `artifacts/${relative}`];
}

export function evidenceKeyVariants(key: string): string[] {
  const normalized = normalizeEvidenceKey(key);
  return [
    ...new Set([normalized, ...exactEvidenceKeys(normalized), path.posix.basename(normalized)]),
  ];
}

/** Qualified paths keep their directory identity; a bare legacy name must be unique. */
export function resolveSelectedEvidenceRef(
  selectedKey: string,
  evidenceManifest: ArtifactRef[],
): ArtifactRef | null {
  const selectedExact = new Set(exactEvidenceKeys(selectedKey));
  const exact = evidenceManifest.filter((artifact) =>
    exactEvidenceKeys(artifact.path).some((key) => selectedExact.has(key)),
  );
  const relative = exactEvidenceKeys(selectedKey)[0];
  const matches = exact.length
    ? exact
    : relative.includes('/')
      ? []
      : evidenceManifest.filter(
          (artifact) => path.posix.basename(exactEvidenceKeys(artifact.path)[0]) === relative,
        );
  const uniquePaths = [...new Set(matches.map((artifact) => exactEvidenceKeys(artifact.path)[0]))];
  if (uniquePaths.length > 1) {
    throw new Error(
      `Selected evidence key is ambiguous (${selectedKey} matches ${uniquePaths.join(', ')})`,
    );
  }
  return matches[0] ?? null;
}
