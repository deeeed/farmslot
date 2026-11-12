import path from 'node:path';

export interface ProjectOwnedPath {
  path: string;
  state: 'current' | 'retired';
}

/** Pack ownership survives removal of a fixture or required skill. */
export function parseProjectOwnedPaths(value: unknown): ProjectOwnedPath[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('fixtures.owned_paths must be an array');
  const seen = new Set<string>();
  const retired = new Set<string>();
  const entries: ProjectOwnedPath[] = value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`Invalid fixtures.owned_paths[${index}]`);
    if (
      !('path' in entry) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      path.posix.isAbsolute(entry.path) ||
      path.posix.normalize(entry.path) !== entry.path ||
      entry.path === '.' ||
      entry.path.endsWith('/') ||
      entry.path.split('/').some((part) => part === '..' || part === '.git') ||
      /[\0\r\n\\*?\[\]]/.test(entry.path) ||
      !('state' in entry) ||
      (entry.state !== 'current' && entry.state !== 'retired') ||
      Object.keys(entry).some((key) => key !== 'path' && key !== 'state')
    )
      throw new Error(
        `Invalid fixtures.owned_paths[${index}]: expected a relative support path and current/retired state`,
      );
    if (seen.has(entry.path)) throw new Error(`Duplicate fixtures.owned_paths path: ${entry.path}`);
    seen.add(entry.path);
    if (entry.state === 'retired') retired.add(entry.path);
    return { path: entry.path, state: entry.state };
  });
  for (const entry of entries) {
    if (entry.state !== 'current') continue;
    for (
      let parent = path.posix.dirname(entry.path);
      parent !== '.';
      parent = path.posix.dirname(parent)
    ) {
      if (retired.has(parent))
        throw new Error(
          `fixtures.owned_paths retired path ${parent} contains current path ${entry.path}`,
        );
    }
  }
  return entries;
}
