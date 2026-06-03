// core/path.ts — Shared filesystem path predicates.

import path from 'node:path';

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return (
    relative === '' ||
    (!!relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
