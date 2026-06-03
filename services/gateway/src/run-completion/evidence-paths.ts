import path from 'node:path';

export function evidenceKeyVariants(key: string): string[] {
  const normalized = key.replace(/\\/g, '/').replace(/^\.?\//, '');
  const withoutArtifacts = normalized.startsWith('artifacts/')
    ? normalized.slice('artifacts/'.length)
    : normalized;
  const base = path.posix.basename(normalized);
  return [...new Set([normalized, withoutArtifacts, `artifacts/${withoutArtifacts}`, base])];
}
