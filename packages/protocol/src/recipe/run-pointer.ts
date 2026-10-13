import { isRecord, isRelativeArtifactPath } from './common.js';

/** Existing task-local selection; publication freezes the selected bytes separately. */
export interface LatestValidRecipeRunPointer {
  version: number;
  runId: string;
  relativeArtifactRoot: string;
  updatedAt?: string;
}

export function sanitizeLatestValidRecipeRunPointer(
  value: unknown,
): LatestValidRecipeRunPointer | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.relativeArtifactRoot !== 'string')
    return null;
  if (!isRelativeArtifactPath(value.relativeArtifactRoot)) return null;
  const parts = value.relativeArtifactRoot
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.');
  if (parts[0] !== 'recipe-runs' || !parts[1]) return null;
  return {
    version: 1,
    runId: parts[1],
    relativeArtifactRoot: parts.join('/'),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}
