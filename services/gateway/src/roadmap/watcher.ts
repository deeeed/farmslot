import { once } from 'node:events';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { type ChokidarOptions, type FSWatcher, watch } from 'chokidar';

import { watchedEventPath } from '../core/file-observation.js';
import { GatewayMethodError } from '../core/method-error.js';
import { publishPlanningResources } from '../resources/planning-changes.js';
import { resourceRevisions } from '../resources/revisions.js';

export interface RoadmapItemObservation {
  assertReady(): void;
  close(): Promise<void>;
}

type RoadmapDirectoryWatch = (directory: string, options: ChokidarOptions) => FSWatcher;

function itemPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    return false;
  const parts = relative.split(path.sep);
  return (
    (parts[0] === 'inbox' && (parts.length === 1 || parts[1] === 'items')) ||
    (parts[0] === 'projects' && (parts.length <= 2 || parts[2] === 'items'))
  );
}

/** Track replacement inodes on Linux and retain changes inside Chokidar's 50ms throttle. */
export async function watchRoadmapItems(
  directory: string,
  revisions = resourceRevisions,
  watchDirectory: RoadmapDirectoryWatch = watch,
): Promise<RoadmapItemObservation> {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  let status: 'starting' | 'ready' | 'failed' | 'closed' = 'starting';
  let failure: Error | undefined;
  const publish = (file: string | null) => {
    if (status === 'closed' || status === 'failed') return;
    if (
      file === null ||
      (itemPath(root, file) && (path.extname(file) === '' || file.endsWith('.md')))
    )
      publishPlanningResources('roadmap', undefined, 'updated', revisions);
  };
  const fail = (error: Error) => {
    if (status === 'closed' || status === 'failed') return;
    failure = error;
    status = 'failed';
    publishPlanningResources('roadmap', undefined, 'updated', revisions);
  };
  const watcher = watchDirectory(root, {
    persistent: false,
    ignoreInitial: true,
    ignored: (file) => file !== root && !itemPath(root, file),
  });
  watcher.on('all', (event, file) => {
    // Discovery catches new descendants before their native handles existed.
    // Existing-file changes use raw events, without delayed atomic reconciliation.
    if (event === 'add' || event === 'addDir') publish(file);
  });
  watcher.on('raw', (_event, filename: unknown, details: unknown) => {
    const file = watchedEventPath(filename, details);
    if (file) publish(file);
  });
  watcher.on('error', (error: unknown) =>
    fail(error instanceof Error ? error : new Error(String(error))),
  );
  try {
    await once(watcher, 'ready');
    if (failure) throw failure;
    status = 'ready';
  } catch (error) {
    await watcher.close();
    throw error;
  }
  return {
    assertReady() {
      if (status === 'ready' && watcher.closed)
        fail(new Error('Roadmap filesystem watcher closed unexpectedly'));
      if (status !== 'ready')
        throw new GatewayMethodError(
          'RESOURCE_OBSERVATION_UNAVAILABLE',
          `Roadmap filesystem observation is ${status}${failure instanceof Error ? `: ${failure.message}` : ''}`,
          { userAction: 'Repair the roadmap filesystem watcher and restart this gateway.' },
        );
    },
    async close() {
      status = 'closed';
      await watcher.close();
    },
  };
}
