import path from 'node:path';

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
