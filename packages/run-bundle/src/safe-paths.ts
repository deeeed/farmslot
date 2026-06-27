import path from 'node:path';

const SAFE_BUNDLE_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_RUN_ID_PATTERN = /^ref-[0-9a-f]{8}-[0-9a-f]{12}$/i;

export function assertSafeBundleRelativePath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe bundle relative path: ${relativePath}`);
  }
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Unsafe bundle relative path: ${relativePath}`);
  }
}

export function assertSafeBundleSegment(segment: string, label: string): void {
  if (!SAFE_BUNDLE_SEGMENT.test(segment)) {
    throw new Error(`Unsafe bundle ${label}: ${segment}`);
  }
}

export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId) && !REFERENCE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Unsafe run id for persistence: ${runId}`);
  }
}

export function resolvePathInsideRoot(rootDir: string, relativePath: string): string {
  assertSafeBundleRelativePath(relativePath);
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes root: ${relativePath}`);
  }
  return resolved;
}
