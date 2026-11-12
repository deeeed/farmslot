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

/** A shell-quoted path may contain apostrophe escapes instead of the raw root. */
export function commandIncludesRemotePath(command: string, root: string): boolean {
  return command.includes(root) || command.includes(root.replaceAll("'", "'\\''"));
}

export function nodePathParams(fullPath: string): { root: string; relPath: string } {
  // '~' is resolved by the node's own expandTilde (commands/fs.ts confinedPath),
  // so home-relative paths like ~/farmslot-node/support/... are valid remote
  // roots — the gateway cannot expand them because the remote home is unknown here.
  if (fullPath === '~' || fullPath.startsWith('~/')) {
    return { root: '~', relPath: fullPath === '~' ? '' : fullPath.slice(2) };
  }
  const root = path.parse(fullPath).root;
  if (!root) throw new Error(`Remote slot path must be absolute: ${fullPath}`);
  return { root, relPath: path.relative(root, fullPath) };
}
