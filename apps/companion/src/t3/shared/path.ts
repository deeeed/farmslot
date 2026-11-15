// From T3 Code packages/shared/src/path.ts (b8c2cfad): the helpers the file links use.

const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[a-zA-Z]:[/\\]/;

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith('\\\\');
}

/**
 * Windows treats `/` and `\` alike, so any two leading separators name a UNC
 * or device path. Touching one makes Windows sign in to that host with the
 * user's NTLM credentials, so agent-authored paths must not reach one.
 */
export function isNetworkPath(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

export function fileBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const caseInsensitive =
    isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot)) ||
    (isNetworkPath(workspaceRoot) && isUncPath(path));
  const normalizedPath = caseInsensitive
    ? stripSlashPrefixedWindowsDrive(path.replaceAll('\\', '/'))
    : path;
  const normalizedRoot = (
    caseInsensitive
      ? stripSlashPrefixedWindowsDrive(workspaceRoot.replaceAll('\\', '/'))
      : workspaceRoot
  ).replace(/\/+$/, '');
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (pathForCompare.replace(/\/+$/, '') === rootForCompare) return '.';
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  // `/repo/../x` starts with the root but escapes it; the server rejects that as a workspace path.
  let depth = 0;
  for (const segment of relativePath.split('/')) {
    if (segment === '..') depth -= 1;
    else if (segment.length > 0 && segment !== '.') depth += 1;
    if (depth < 0) return null;
  }
  return relativePath;
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolutePath(value);
}
