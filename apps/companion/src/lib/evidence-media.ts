import {
  type ContentPrefetchMedia,
  type ContentPrefetchMediaEntry,
  createSha256,
} from '@farmslot/protocol/client-cache';

/** Pending gates' large evidence kept on the device. Past this, older gates make room. */
export const EVIDENCE_MEDIA_LIMIT_BYTES = 400 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

/** The file operations the holder needs; `directory` ends with '/'. */
export interface EvidenceMediaFiles {
  directory: string;
  /** Bytes on disk, or undefined when the file is gone (the OS may reclaim the cache). */
  size(uri: string): Promise<number | undefined>;
  /** Rejects once `signal` aborts; the partial file may be left at `to`. */
  download(
    source: { uri: string; headers?: Record<string, string> },
    to: string,
    signal: AbortSignal,
  ): Promise<number>;
  read(uri: string, position: number, length: number): Promise<Uint8Array>;
  move(from: string, to: string): Promise<void>;
  /** Idempotent: a file that is already gone is no error. */
  remove(uri: string): Promise<void>;
  readText(uri: string): Promise<string | undefined>;
  writeText(uri: string, text: string): Promise<void>;
  /** Deletes the whole directory. */
  clear(): Promise<void>;
}

export interface EvidenceMediaOptions {
  files: EvidenceMediaFiles;
  /** The authenticated artifact URL for an entry. */
  source(entry: ContentPrefetchMediaEntry): { uri: string; headers?: Record<string, string> };
  /** Large downloads only while this holds (a LAN route, the Wi-Fi proxy without a network API). */
  allowed(): boolean;
  limitBytes?: number;
  log?(message: string): void;
}

export interface EvidenceMediaLookup {
  /** Called once the index is read and whenever held files change, so readers render again. */
  subscribe(listener: () => void): () => void;
  /** The held file for a run artifact of exactly this package (bundle digest). */
  byPath(runId: string, path: string, bundleDigest: string | undefined): string | undefined;
  byDigest(sha256: string): string | undefined;
}

export interface EvidenceMediaHolder extends ContentPrefetchMedia, EvidenceMediaLookup {
  /** Drops every run not listed (decided, or no longer waiting) and files no run still uses. */
  keep(gateRunIds: ReadonlySet<string>): Promise<void>;
  /** Stops: nothing in flight is kept. The files stay for the scope's next holder. */
  dispose(): void;
  /** Stops and deletes every held file: the scope's offline store was deleted. */
  destroy(): Promise<void>;
  totals(): { bytes: number; files: number; runs: number };
}

interface HeldPath {
  sha256: string;
  bundleDigest?: string;
}

interface Index {
  files: Record<string, { bytes: number; name: string }>;
  runs: Record<string, { gateAt: number; paths: Record<string, HeldPath> }>;
}

function extension(path: string): string {
  const match = /\.[a-z0-9]{1,5}$/i.exec(path);
  return match ? match[0].toLowerCase() : '';
}

export function createEvidenceMediaHolder(options: EvidenceMediaOptions): EvidenceMediaHolder {
  const { files } = options;
  const limit = options.limitBytes ?? EVIDENCE_MEDIA_LIMIT_BYTES;
  const log = options.log ?? (() => {});
  const indexUri = `${files.directory}index.json`;
  let index: Index = { files: {}, runs: {} };
  let disposed = false;
  // Aborts the holder's downloads when it is disposed or destroyed.
  const stopped = new AbortController();
  /** The gates the last decision list still waits on; undefined until one is known. */
  let wanted: ReadonlySet<string> | undefined;
  const inflight = new Map<string, Promise<boolean>>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  // Capacity checks and commits run one at a time, so two downloads cannot both fit the bound.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    // The queue only orders tasks; each task's own failure reaches its caller through `run`.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const total = () => Object.values(index.files).reduce((sum, file) => sum + file.bytes, 0);
  const save = () => files.writeText(indexUri, JSON.stringify(index));
  const referenced = (sha256: string) =>
    Object.values(index.runs).some((run) =>
      Object.values(run.paths).some((held) => held.sha256 === sha256),
    );
  const live = (runId: string) => !disposed && (!wanted || wanted.has(runId));

  /** Whether a held file is still on disk; one the OS reclaimed is forgotten, so it can load again. */
  async function present(sha256: string): Promise<boolean> {
    const file = index.files[sha256];
    if (!file) return false;
    if ((await files.size(files.directory + file.name)) === file.bytes) return true;
    delete index.files[sha256];
    for (const run of Object.values(index.runs))
      for (const [path, held] of Object.entries(run.paths))
        if (held.sha256 === sha256) delete run.paths[path];
    log(`[evidence-media] reclaimed ${sha256.slice(0, 12)}`);
    return false;
  }

  // Read once the helpers below exist; every public call waits for it.
  const loaded = (async () => {
    const text = await files.readText(indexUri);
    if (!text) return;
    try {
      index = JSON.parse(text) as Index;
    } catch (error) {
      // Files an unreadable index no longer counts would sit outside the bound: start over.
      log(`[evidence-media] index unreadable, clearing: ${String(error)}`);
      await files.clear();
      return;
    }
    let reclaimed = false;
    for (const sha256 of Object.keys(index.files))
      reclaimed = !(await present(sha256)) || reclaimed;
    if (reclaimed) await save();
  })().finally(changed);

  async function dropUnreferenced(): Promise<void> {
    for (const [sha256, file] of Object.entries(index.files))
      if (!referenced(sha256)) {
        await files.remove(files.directory + file.name);
        delete index.files[sha256];
        log(`[evidence-media] evicted ${sha256.slice(0, 12)} (${file.bytes} B)`);
      }
  }

  /** Gates older than `gateAt`, oldest first: the only ones a newer gate may displace. */
  const olderGates = (gateAt: number) =>
    Object.entries(index.runs)
      .filter(([, run]) => run.gateAt < gateAt)
      .sort(([, a], [, b]) => a.gateAt - b.gateAt)
      .map(([id]) => id);

  /** Whether `bytes` fit once every file only older gates use were gone. */
  function fits(bytes: number, gateAt: number): boolean {
    const dropped = new Set(olderGates(gateAt));
    const freeable = Object.entries(index.files)
      .filter(([sha256]) => {
        const users = Object.entries(index.runs).filter(([, run]) =>
          Object.values(run.paths).some((held) => held.sha256 === sha256),
        );
        return users.length > 0 && users.every(([id]) => dropped.has(id));
      })
      .reduce((sum, [, file]) => sum + file.bytes, 0);
    return total() - freeable + bytes <= limit;
  }

  /** Room for `bytes` by dropping only gates older than the one being filled. */
  async function makeRoom(bytes: number, gateAt: number): Promise<boolean> {
    if (total() + bytes <= limit) return true;
    if (!fits(bytes, gateAt)) return false;
    for (const id of olderGates(gateAt)) {
      if (total() + bytes <= limit) break;
      delete index.runs[id];
      await dropUnreferenced();
    }
    return total() + bytes <= limit;
  }

  async function verify(uri: string, bytes: number, sha256: string): Promise<boolean> {
    const hash = createSha256();
    for (let position = 0; position < bytes; position += HASH_CHUNK_BYTES)
      hash.update(await files.read(uri, position, Math.min(HASH_CHUNK_BYTES, bytes - position)));
    return hash.hex() === sha256;
  }

  async function fetchFile(entry: ContentPrefetchMediaEntry, signal: AbortSignal) {
    const part = `${files.directory}${entry.sha256}.part`;
    let bytes: number;
    try {
      bytes = await files.download(options.source(entry), part, stopped.signal);
    } catch (error) {
      // An entry that cannot download now is skipped; the gate's other evidence still loads.
      await files.remove(part);
      if (!stopped.signal.aborted)
        log(`[evidence-media] download failed ${entry.path}: ${String(error)}`);
      return false;
    }
    const verified = !signal.aborted && (await verify(part, bytes, entry.sha256));
    return serialized(async () => {
      if (!verified || !live(entry.runId) || !(await makeRoom(bytes, entry.gateAt))) {
        await files.remove(part);
        if (!verified && !signal.aborted)
          log(`[evidence-media] digest mismatch ${entry.sha256.slice(0, 12)}`);
        return false;
      }
      const name = entry.sha256 + extension(entry.path);
      await files.move(part, files.directory + name);
      index.files[entry.sha256] = { bytes, name };
      // Counted and owned in one step, so the next commit's room check sees this gate's file.
      attach(entry);
      await save();
      changed();
      log(
        `[evidence-media] held ${entry.sha256.slice(0, 12)} ${entry.path} (${bytes} B, ${total()}/${limit} B)`,
      );
      return true;
    });
  }

  function attach(entry: ContentPrefetchMediaEntry): void {
    const run = (index.runs[entry.runId] ??= { gateAt: entry.gateAt, paths: {} });
    run.gateAt = Math.max(run.gateAt, entry.gateAt);
    run.paths[entry.path] = { sha256: entry.sha256, bundleDigest: entry.bundleDigest };
  }

  function heldPath(runId: string, path: string): HeldPath | undefined {
    return index.runs[runId]?.paths[path];
  }

  function byDigest(sha256: string): string | undefined {
    const file = disposed ? undefined : index.files[sha256];
    return file ? files.directory + file.name : undefined;
  }

  return {
    async hold(entry, signal) {
      await loaded;
      if (!live(entry.runId)) return false;
      // A new package for this path replaces the old mapping first, so a refused or failed hold
      // never leaves the previous package's file standing in for this one. Like every change to
      // ownership, it runs in the queue, so another gate's hold of the same digest is not undone.
      const held = await serialized(async () => {
        const previous = heldPath(entry.runId, entry.path);
        if (
          previous &&
          (previous.sha256 !== entry.sha256 || previous.bundleDigest !== entry.bundleDigest)
        ) {
          delete index.runs[entry.runId].paths[entry.path];
          await dropUnreferenced();
          await save();
        }
        if (await present(entry.sha256)) return true;
        // Not held (any more): a reclaimed entry was just forgotten, so record that.
        await save();
        return false;
      });
      if (!held) {
        if (!options.allowed()) {
          log(`[evidence-media] skipped ${entry.path}: not on a LAN route`);
          return false;
        }
        // A file that could not fit is not downloaded at all.
        if (entry.sizeBytes !== undefined && !fits(entry.sizeBytes, entry.gateAt)) {
          log(`[evidence-media] skipped ${entry.path}: no room (${entry.sizeBytes} B)`);
          return false;
        }
        // Two gates sharing a digest download it once.
        let pending = inflight.get(entry.sha256);
        if (!pending) {
          pending = fetchFile(entry, signal).finally(() => inflight.delete(entry.sha256));
          inflight.set(entry.sha256, pending);
        }
        if (!(await pending)) return false;
      }
      return serialized(async () => {
        if (!live(entry.runId) || !index.files[entry.sha256]) return false;
        attach(entry);
        await save();
        changed();
        return true;
      });
    },
    async keep(gateRunIds) {
      await loaded;
      const ids = [...gateRunIds].sort();
      if (!wanted || ids.join() !== [...wanted].sort().join())
        // The first known list too, so "nothing waits on a decision" is visible, not silent.
        log(
          `[evidence-media] gates waiting: ${ids.length}${ids.length ? ` (${ids.map((id) => id.slice(0, 8)).join(', ')})` : ''}`,
        );
      wanted = gateRunIds;
      await serialized(async () => {
        const before = Object.keys(index.runs).length;
        for (const runId of Object.keys(index.runs))
          if (!gateRunIds.has(runId)) delete index.runs[runId];
        if (Object.keys(index.runs).length === before) return;
        await dropUnreferenced();
        await save();
        changed();
      });
    },
    byPath(runId, path, bundleDigest) {
      const held = disposed ? undefined : heldPath(runId, path);
      return held && held.bundleDigest === bundleDigest ? byDigest(held.sha256) : undefined;
    },
    byDigest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      stopped.abort();
    },
    async destroy() {
      disposed = true;
      stopped.abort();
      await loaded;
      await serialized(async () => {
        index = { files: {}, runs: {} };
        await files.clear();
        log('[evidence-media] cleared');
        changed();
      });
    },
    totals: () => ({
      bytes: total(),
      files: Object.keys(index.files).length,
      runs: Object.keys(index.runs).length,
    }),
  };
}
