import {
  type FSWatcher,
  watch,
  type WatchListener,
  type WatchOptionsWithStringEncoding,
} from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { GatewayMethodError } from '../core/method-error.js';
import { publishPlanningResources } from '../resources/planning-changes.js';
import { resourceRevisions } from '../resources/revisions.js';

export interface RoadmapItemObservation {
  assertReady(): void;
  close(): Promise<void>;
}

type RoadmapDirectoryWatch = (
  directory: string,
  options: WatchOptionsWithStringEncoding,
  listener: WatchListener<string>,
) => FSWatcher;

/** Item directories may be created or replaced after observation starts. */
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

/** Native directory events retain rapid atomic replacements that Chokidar's change throttle drops. */
export async function watchRoadmapItems(
  directory: string,
  revisions = resourceRevisions,
  watchDirectory: RoadmapDirectoryWatch = watch,
): Promise<RoadmapItemObservation> {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  let status: 'starting' | 'ready' | 'failed' | 'closed' = 'starting';
  let failure: Error | undefined;
  const fail = (error: Error) => {
    if (status === 'closed' || status === 'failed') return;
    failure = error;
    status = 'failed';
    publishPlanningResources('roadmap', undefined, 'updated', revisions);
  };
  const watcher: FSWatcher = watchDirectory(
    root,
    { recursive: true, persistent: false },
    (event, filename) => {
      if (status === 'closed' || status === 'failed') return;
      // A missing filename or a renamed item directory cannot safely narrow the affected items.
      if (
        filename === null ||
        (itemPath(root, path.join(root, String(filename))) &&
          (event === 'rename' || String(filename).endsWith('.md')))
      )
        publishPlanningResources('roadmap', undefined, 'updated', revisions);
    },
  );
  watcher.on('error', fail);
  watcher.on('close', () => fail(new Error('Roadmap filesystem watcher closed unexpectedly')));
  // The native handle is armed on return; also surface a queued startup error before admission.
  await Promise.resolve();
  if (failure) {
    watcher.close();
    throw failure;
  }
  status = 'ready';
  return {
    assertReady() {
      if (status !== 'ready')
        throw new GatewayMethodError(
          'RESOURCE_OBSERVATION_UNAVAILABLE',
          `Roadmap filesystem observation is ${status}${failure instanceof Error ? `: ${failure.message}` : ''}`,
          { userAction: 'Repair the roadmap filesystem watcher and restart this gateway.' },
        );
    },
    async close() {
      status = 'closed';
      watcher.close();
    },
  };
}
