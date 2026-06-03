// live-recipe-artifact-filters.ts — Artifact path normalization and scan filters for live recipe context.

export interface ArtifactScanOptions {
  excludeTopLevel?: string[];
  includeRelativePaths?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeArtifactRelativePath(value: string): string | null {
  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^artifacts\//, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.includes('\0')
  ) {
    return null;
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  return segments.join('/');
}

function collectEvidenceManifestPath(value: unknown, paths: Set<string>): void {
  if (typeof value !== 'string') return;
  const normalized = normalizeArtifactRelativePath(value);
  if (normalized) paths.add(normalized);
}

function logJsonParseFailure(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[live-recipe-context] failed to parse ${context}: ${message}`);
}

export function extractEvidenceManifestReferencedPaths(
  raw: string | null,
  contextPath: string,
): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      before_after_pairs?: unknown;
      standalone?: unknown;
      videos?: unknown;
    };
    const paths = new Set<string>();
    if (Array.isArray(parsed.before_after_pairs)) {
      for (const entry of parsed.before_after_pairs) {
        if (!isRecord(entry)) continue;
        collectEvidenceManifestPath(entry.before, paths);
        collectEvidenceManifestPath(entry.after, paths);
      }
    }
    if (Array.isArray(parsed.standalone)) {
      for (const entry of parsed.standalone) {
        if (!isRecord(entry)) continue;
        collectEvidenceManifestPath(entry.file, paths);
      }
    }
    if (isRecord(parsed.videos)) {
      for (const [key, value] of Object.entries(parsed.videos)) {
        if (key === 'note' || key === 'preferred') continue;
        collectEvidenceManifestPath(value, paths);
      }
    }
    return [...paths];
  } catch (error) {
    logJsonParseFailure(contextPath, error);
    return [];
  }
}

export function artifactScanFilters(options: ArtifactScanOptions): {
  excludedTopLevel: Set<string>;
  includedRelativePaths: Set<string>;
} {
  return {
    excludedTopLevel: new Set(options.excludeTopLevel ?? []),
    includedRelativePaths: new Set(
      (options.includeRelativePaths ?? []).flatMap((value) => {
        const normalized = normalizeArtifactRelativePath(value);
        return normalized ? [normalized] : [];
      }),
    ),
  };
}

export function shouldSkipArtifactName(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('.');
}

function isExcludedRelativePath(relativePath: string, excludedTopLevel: Set<string>): boolean {
  const [topLevel] = normalizeArtifactRelativePath(relativePath)?.split('/') ?? [];
  return Boolean(topLevel && excludedTopLevel.has(topLevel));
}

export function shouldVisitArtifactDirectory(
  relativePath: string,
  excludedTopLevel: Set<string>,
  includedRelativePaths: Set<string>,
): boolean {
  if (!isExcludedRelativePath(relativePath, excludedTopLevel)) return true;
  const prefix = `${normalizeArtifactRelativePath(relativePath)}/`;
  return [...includedRelativePaths].some((includedPath) => includedPath.startsWith(prefix));
}

export function shouldIncludeArtifactFile(
  relativePath: string,
  excludedTopLevel: Set<string>,
  includedRelativePaths: Set<string>,
): boolean {
  const normalized = normalizeArtifactRelativePath(relativePath);
  if (!normalized) return false;
  if (!isExcludedRelativePath(normalized, excludedTopLevel)) return true;
  return includedRelativePaths.has(normalized);
}
