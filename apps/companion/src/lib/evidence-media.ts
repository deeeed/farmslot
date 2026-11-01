import {
  type ContentPrefetchMedia,
  type ContentPrefetchMediaEntry,
  createSha256,
} from '@farmslot/protocol/client-cache';

/** Pending gates' large evidence kept on the device. Oldest gates go first past this. */
export const EVIDENCE_MEDIA_LIMIT_BYTES = 400 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

/** The file operations the holder needs; `directory` ends with '/'. */
export interface EvidenceMediaFiles {
  directory: string;
  size(uri: string): Promise<number | undefined>;
  download(source: { uri: string; headers?: Record<string, string> }, to: string): Promise<number>;
  read(uri: string, position: number, length: number): Promise<Uint8Array>;
  move(from: string, to: string): Promise<void>;
  remove(uri: string): Promise<void>;
  readText(uri: string): Promise<string | undefined>;
  writeText(uri: string, text: string): Promise<void>;
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

export interface EvidenceMediaHolder extends ContentPrefetchMedia {
  /** Drops every run not listed (decided, or no longer waiting) and files no run still uses. */
  keep(gateRunIds: ReadonlySet<string>): Promise<void>;
  /** The held file for a run's artifact path, read silently instead of the network. */
  localUri(runId: string, path: string): string | undefined;
  localUriForDigest(sha256: string): string | undefined;
  totals(): { bytes: number; files: number; runs: number };
}

interface Index {
  files: Record<string, { bytes: number; name: string }>;
  runs: Record<string, { gateAt: number; paths: Record<string, string> }>;
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
  const inflight = new Map<string, Promise<boolean>>();
  const loaded = (async () => {
    try {
      const text = await files.readText(indexUri);
      if (text) index = JSON.parse(text) as Index;
    } catch {
      index = { files: {}, runs: {} };
    }
  })();

  const total = () => Object.values(index.files).reduce((sum, file) => sum + file.bytes, 0);
  const save = () => files.writeText(indexUri, JSON.stringify(index));
  const referenced = (sha256: string) =>
    Object.values(index.runs).some((run) => Object.values(run.paths).includes(sha256));

  async function dropUnreferenced(): Promise<void> {
    for (const [sha256, file] of Object.entries(index.files))
      if (!referenced(sha256)) {
        delete index.files[sha256];
        await files.remove(files.directory + file.name).catch(() => undefined);
        log(`[evidence-media] evicted ${sha256.slice(0, 12)} (${file.bytes} B)`);
      }
  }

  /** Oldest gates go first; the gate being filled is never its own victim. */
  async function makeRoom(bytes: number, runId: string): Promise<boolean> {
    const victims = Object.entries(index.runs)
      .filter(([id]) => id !== runId)
      .sort(([, a], [, b]) => a.gateAt - b.gateAt);
    while (total() + bytes > limit && victims.length) {
      const [id] = victims.shift()!;
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
    const name = entry.sha256 + extension(entry.path);
    const part = `${files.directory}${entry.sha256}.part`;
    let bytes: number;
    try {
      bytes = await files.download(options.source(entry), part);
    } catch (error) {
      // A failed download skips this file; the gate's other evidence still loads.
      await files.remove(part).catch(() => undefined);
      log(
        `[evidence-media] download failed ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (signal.aborted || !(await verify(part, bytes, entry.sha256))) {
      await files.remove(part).catch(() => undefined);
      if (!signal.aborted) log(`[evidence-media] digest mismatch ${entry.sha256.slice(0, 12)}`);
      return false;
    }
    if (!(await makeRoom(bytes, entry.runId))) {
      await files.remove(part).catch(() => undefined);
      return false;
    }
    await files.move(part, files.directory + name);
    index.files[entry.sha256] = { bytes, name };
    log(
      `[evidence-media] held ${entry.sha256.slice(0, 12)} ${entry.path} (${bytes} B, ${total()}/${limit} B)`,
    );
    return true;
  }

  function attach(entry: ContentPrefetchMediaEntry): void {
    const run = (index.runs[entry.runId] ??= { gateAt: entry.gateAt, paths: {} });
    run.gateAt = Math.max(run.gateAt, entry.gateAt);
    run.paths[entry.path] = entry.sha256;
  }

  function localUriForDigest(sha256: string): string | undefined {
    const file = index.files[sha256];
    return file ? files.directory + file.name : undefined;
  }

  return {
    async hold(entry, signal) {
      await loaded;
      if (index.files[entry.sha256]) {
        attach(entry);
        await save();
        return true;
      }
      if (!options.allowed()) return false;
      if ((entry.sizeBytes ?? 0) > limit) return false;
      if (entry.sizeBytes && !(await makeRoom(entry.sizeBytes, entry.runId))) return false;
      // Two gates sharing a digest download it once.
      let pending = inflight.get(entry.sha256);
      if (!pending) {
        pending = fetchFile(entry, signal).finally(() => inflight.delete(entry.sha256));
        inflight.set(entry.sha256, pending);
      }
      if (!(await pending)) return false;
      attach(entry);
      await save();
      return true;
    },
    async keep(gateRunIds) {
      await loaded;
      const before = Object.keys(index.runs).length;
      for (const runId of Object.keys(index.runs))
        if (!gateRunIds.has(runId)) delete index.runs[runId];
      if (Object.keys(index.runs).length === before) return;
      await dropUnreferenced();
      await save();
    },
    localUri(runId, path) {
      const sha256 = index.runs[runId]?.paths[path];
      return sha256 ? localUriForDigest(sha256) : undefined;
    },
    localUriForDigest,
    totals: () => ({
      bytes: total(),
      files: Object.keys(index.files).length,
      runs: Object.keys(index.runs).length,
    }),
  };
}
