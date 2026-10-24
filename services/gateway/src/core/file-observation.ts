import path from 'node:path';

/** Resolve Chokidar's unthrottled native event without assuming a directory-only watch. */
export function watchedEventPath(filename: unknown, details: unknown): string | undefined {
  const watched =
    details && typeof details === 'object' ? Reflect.get(details, 'watchedPath') : undefined;
  if (typeof filename !== 'string') return typeof watched === 'string' ? watched : undefined;
  if (path.isAbsolute(filename)) return filename;
  if (typeof watched !== 'string') return undefined;
  return path.basename(watched) === filename ? watched : path.join(watched, filename);
}
