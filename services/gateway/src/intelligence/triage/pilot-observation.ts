import { once } from 'node:events';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { type ChokidarOptions, type FSWatcher, watch } from 'chokidar';

import {
  TRIAGE_PILOT_FILE_NAMES,
  TriagePilotObservationUnavailable,
} from '../../assessment/failure-triage/pilot-source.js';
import { watchedEventPath } from '../../core/file-observation.js';
import { resourceRevisions } from '../../resources/revisions.js';

import { readTriagePolicy } from './policy.js';

type WatchDirectories = (roots: string[], options: ChokidarOptions) => FSWatcher;
type SourceStatus = 'starting' | 'ready' | 'disabled' | 'failed' | 'closed';

function ancestor(file: string, directory: string): boolean {
  const relative = path.relative(file, directory);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function artifactSources(directory: string): { files: Set<string>; links: string[] } {
  const files = new Set<string>();
  const links: string[] = [];
  const pending = TRIAGE_PILOT_FILE_NAMES.map((name) => ({
    file: path.join(directory, name),
    depth: 0,
  }));
  while (pending.length) {
    const { file, depth } = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (!entry) continue;
    const canonicalParent = realpathSync(path.dirname(file));
    const canonicalFile = path.join(canonicalParent, path.basename(file));
    if (canonicalFile !== file) pending.push({ file: canonicalFile, depth });
    if (!entry.isSymbolicLink()) continue;
    if (depth >= 40) throw new TriagePilotObservationUnavailable();
    const target = readlinkSync(file);
    links.push(`${file}:${entry.dev}:${entry.ino}:${target}`);
    pending.push({ file: path.resolve(canonicalParent, target), depth: depth + 1 });
  }
  return { files, links: links.sort() };
}

function topology(directory: string): string {
  try {
    const entry = lstatSync(directory);
    const { links } = artifactSources(directory);
    return `${entry.dev}:${entry.ino}:${realpathSync(directory)}:${JSON.stringify(links)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function existingParent(directory: string): string {
  let parent = path.dirname(directory);
  while (!statSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
    const next = path.dirname(parent);
    if (next === parent) throw new TriagePilotObservationUnavailable();
    parent = next;
  }
  return parent;
}

/** One policy-selected, nonrecursive admitted receipt set per gateway home. */
export class TriagePilotObservation {
  private status: SourceStatus = 'disabled';
  private directory?: string;
  private observedTopology?: string;
  private watcher?: FSWatcher;
  private cancellation?: AbortController;
  private generation = 0;

  constructor(
    private readonly home: string,
    private readonly revisions = resourceRevisions,
    private readonly watchDirectories: WatchDirectories = watch,
  ) {}

  private publish(): void {
    this.revisions.advance({ family: 'assessment', scope: 'farm' });
  }

  private fail(): void {
    if (this.status === 'failed' || this.status === 'closed') return;
    this.status = 'failed';
    this.publish();
  }

  private hasFailed(): boolean {
    return this.status === 'failed';
  }

  async refresh(): Promise<void> {
    if (this.status === 'closed') return;
    const generation = ++this.generation;
    this.cancellation?.abort();
    const previous = this.watcher;
    this.watcher = undefined;
    this.status = 'starting';
    this.directory = undefined;
    await previous?.close();
    if (generation !== this.generation) return;
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    let watcher: FSWatcher | undefined;
    try {
      const policy = await readTriagePolicy(this.home);
      if (generation !== this.generation) return;
      if (!policy.enabled) {
        this.status = 'disabled';
        return;
      }
      const directory = path.resolve(policy.receiptDirectory);
      const identity = topology(directory);
      const directories = new Set([directory]);
      if (identity !== 'missing') directories.add(realpathSync(directory));
      const files = new Set([...directories].flatMap((root) => [...artifactSources(root).files]));
      const roots = [...new Set([...directories, ...files].map(existingParent))];
      const selected = (file: string) =>
        [...directories, ...files].some((target) => ancestor(file, target));
      watcher = this.watchDirectories(roots, {
        persistent: false,
        ignoreInitial: true,
        followSymlinks: true,
        ignored: (file, stats) =>
          !selected(file) ||
          (stats?.isDirectory() === true && files.has(file) && !directories.has(file)),
      });
      this.watcher = watcher;
      this.directory = directory;
      this.observedTopology = identity;
      const changed = (file: string) => {
        if (generation !== this.generation || this.status === 'closed' || !selected(file)) return;
        // Reattach after removal/replacement or a symlink changing its selected target.
        try {
          if (this.status === 'failed' || topology(directory) !== identity) {
            void this.refresh();
            return;
          }
        } catch {
          // An unreadable selected source loses admission until a real filesystem recovery.
          this.fail();
          return;
        }
        this.publish();
      };
      watcher.on('all', (event, file) => {
        if (['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) changed(file);
      });
      watcher.on('raw', (_event, filename: unknown, details: unknown) => {
        const file = watchedEventPath(filename, details);
        if (file) changed(file);
      });
      watcher.on('error', () => {
        if (generation === this.generation) this.fail();
      });
      await once(watcher, 'ready', { signal: cancellation.signal });
      if (generation !== this.generation) {
        await watcher.close();
        return;
      }
      if (this.hasFailed()) return;
      this.status = 'ready';
      this.publish();
    } catch {
      await watcher?.close();
      if (generation !== this.generation || cancellation.signal.aborted) return;
      // Invalid/unreadable policy or failed source observation is a published failure,
      // never an admitted empty set. The owning getter reports its actual prerequisite error.
      this.fail();
    }
  }

  assertReady(directory: string): void {
    if (this.status === 'ready' && this.watcher?.closed) this.fail();
    let sameTopology = false;
    try {
      sameTopology =
        this.directory !== undefined && topology(this.directory) === this.observedTopology;
    } catch {
      this.fail();
    }
    if (!sameTopology && this.status === 'ready') {
      void this.refresh();
      throw new TriagePilotObservationUnavailable();
    }
    if (this.status !== 'ready' || path.resolve(directory) !== this.directory || !sameTopology)
      throw new TriagePilotObservationUnavailable();
  }

  async close(): Promise<void> {
    ++this.generation;
    this.status = 'closed';
    this.cancellation?.abort();
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
