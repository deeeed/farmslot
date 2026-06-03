import path from 'node:path';

export function isShellHomePath(inputPath: string): boolean {
  return inputPath === '~' || inputPath.startsWith('~/');
}

export function normalizeRemotePath(inputPath: string): string {
  return path.posix.normalize(inputPath.replaceAll('\\', '/'));
}

export function shellExpressionForRemotePath(inputPath: string): string {
  const normalizedPath = normalizeRemotePath(inputPath);
  if (!isShellHomePath(normalizedPath)) {
    return `'${normalizedPath.replaceAll("'", `'\\''`)}'`;
  }
  const suffix = normalizedPath === '~' ? '' : normalizedPath.slice(1);
  const escapedSuffix = suffix.replace(/["\\$`]/g, '\\$&');
  return `"${'${HOME}'}${escapedSuffix}"`;
}

export function resolvePathWithinRemoteBase(basePath: string, relativePath: string): string | null {
  const normalizedBasePath = normalizeRemotePath(basePath);
  const normalizedRelativePath = normalizeRemotePath(relativePath);
  if (path.posix.isAbsolute(normalizedRelativePath)) return null;
  const targetPath = path.posix.normalize(
    path.posix.join(normalizedBasePath, normalizedRelativePath),
  );
  const relativeTargetPath = path.posix.relative(normalizedBasePath, targetPath);
  if (
    relativeTargetPath === '..' ||
    relativeTargetPath.startsWith('../') ||
    path.posix.isAbsolute(relativeTargetPath)
  ) {
    return null;
  }
  return targetPath;
}
