import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import lockfile from 'proper-lockfile';

import {
  type ArtifactRef,
  decisionArtifactBundleRef,
  isActiveListRun,
  type Run,
  RUN_BUNDLE_VERSION,
  type RunArtifactBundleRef,
  type RunBundleManifest,
  type RunBundleRetentionPolicy,
  type RunDecision,
} from '@farmslot/protocol';
import {
  listProjectTaskRoots,
  ORCHESTRATOR_TASK_DIR,
  resolveProjectsDir,
} from '@farmslot/protocol/node/farm-layout';
import {
  sanitizeRunForBundleExport,
  strictTaskRelativePathFromFarmslotRoot,
} from '@farmslot/protocol/runs/portable-bundle';

import { loadAllRunRecords } from './collect.js';
import { shouldSkipBundleFilesystemEntry } from './copy-tree.js';
import { sha256Text } from './hashing.js';
import { parseManifest } from './import.js';
import {
  assertSafeBundleRelativePath,
  assertSafeBundleSegment,
  resolvePathInsideRoot,
} from './safe-paths.js';

export const DEFAULT_RUN_BUNDLE_RETENTION: Readonly<RunBundleRetentionPolicy> = {
  maxBundleBytes: 2 * 1024 ** 3,
  maxStoreBytes: 20 * 1024 ** 3,
  metadataReserveBytes: 512 * 1024 ** 2,
  mediaRetentionDays: 30,
};

export interface RunBundleStore {
  version: 1;
  id: string;
  runsDir: string;
  root: string;
}

interface CaptureIntent {
  runId: string;
  key: string;
  bundleId: string;
  exportedAt: string;
  runJson: string;
  bundleDigest?: string;
  committed?: boolean;
}

export interface RunBundlePayloadIdentity {
  sha256: string;
  bytes: number;
}

export interface MaterializeRunBundleRequest {
  store: RunBundleStore;
  farmslotRoot: string;
  run: Run;
  taskDir: string;
  /** Gateway-written files read from this directory instead of `taskDir`. */
  gatewayFiles?: { taskDir: string; paths: readonly string[] };
  artifacts: readonly ArtifactRef[];
  manifestDigest: string;
  /** Persisted identity of this acquisition, including task and generation. */
  captureKey: string;
  existingRef?: RunArtifactBundleRef;
  policy?: RunBundleRetentionPolicy;
  /** Import extraction bytes outside the gateway acquisition roots. */
  stagingBytes?: number;
  /** Inventory is frozen before metadata commits; media transport writes only admitted bytes. */
  acquireMedia?: (
    artifact: ArtifactRef,
    destination: string,
    maxBytes: number,
  ) => Promise<RunBundlePayloadIdentity>;
  allowChanged?: boolean;
  /** Must fence and durably commit the Run reference before returning. */
  commit(ref: RunArtifactBundleRef, missingData: string[]): Promise<void>;
}

export interface MaterializedRunBundle {
  ref: RunArtifactBundleRef;
  manifest: RunBundleManifest;
  missingData: string[];
  acquisitionScan: AcquisitionScan;
}

interface AcquisitionScan {
  bytes: number;
  fileCount: number;
  durationMs: number;
}

export interface RunBundleAvailability {
  revision: number;
  prunedPaths: string[];
}

export interface ResolvedRunBundleEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RetainedRunBundleSnapshot {
  directory: string;
  taskDir: string;
  manifest: RunBundleManifest;
  resolveEntry(file: string): Promise<ResolvedRunBundleEntry>;
  readText(file: string): Promise<string>;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function syncPath(file: string): Promise<void> {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  await syncPath(path.dirname(file));
}

/** The Run store, rather than the caller's auth home, owns this durable pairing. */
export async function openRunBundleStore(input: {
  runsDir: string;
  home: string;
  create?: boolean;
}): Promise<RunBundleStore> {
  await mkdir(input.runsDir, { recursive: true });
  const runsDir = await realpath(input.runsDir);
  const bindingPath = path.join(runsDir, 'bundle-store.json');
  let raw = await readOptional(bindingPath);
  if (!raw) {
    if (!input.create)
      throw new Error('Run bundle store pairing is missing; start the owning gateway.');
    const root = path.resolve(input.home, 'run-bundles');
    await mkdir(root, { recursive: true });
    const binding: RunBundleStore = {
      version: 1,
      id: randomUUID(),
      runsDir,
      root: await realpath(root),
    };
    const text = `${JSON.stringify(binding, null, 2)}\n`;
    try {
      await writeFile(bindingPath, text, { flag: 'wx', mode: 0o600 });
      raw = text;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      raw = await readFile(bindingPath, 'utf8');
    }
  }
  const binding: RunBundleStore = JSON.parse(raw);
  if (
    binding.version !== 1 ||
    !binding.id ||
    binding.runsDir !== runsDir ||
    !path.isAbsolute(binding.root)
  )
    throw new Error('Run bundle store pairing does not match the canonical Run store.');
  const ownerPath = path.join(binding.root, 'store.json');
  let owner = await readOptional(ownerPath);
  if (
    !owner &&
    input.create &&
    binding.root === path.join(await realpath(input.home), 'run-bundles')
  ) {
    try {
      await writeFile(ownerPath, `${JSON.stringify(binding)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    owner = await readFile(ownerPath, 'utf8');
  }
  if (!owner || JSON.stringify(JSON.parse(owner)) !== JSON.stringify(binding))
    throw new Error('Run bundle root belongs to a different Run store.');
  return binding;
}

/** One cross-process lock covers capacity reservations, commit and GC. */
export function withRunBundleStoreLock<T>(store: RunBundleStore, fn: () => Promise<T>): Promise<T> {
  return withBundleLock(store, 'bundle-store.lock', fn);
}

const bundleLockQueues = new Map<string, Promise<unknown>>();

async function withBundleLock<T>(
  store: RunBundleStore,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const options = bundleLockOptions(store, name);
  const execute = async () => {
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(options.lockfilePath, {
        ...options,
        update: 2_000,
        retries: { retries: 1500, factor: 1, minTimeout: 20, maxTimeout: 50 },
      });
    } catch (error) {
      if (!hasCode(error, 'ELOCKED')) throw error;
      throw Object.assign(
        new Error(
          `Run bundle lock retries exhausted: ${options.lockfilePath}; waiting process ${process.pid}`,
          { cause: error },
        ),
        { code: 'ELOCKED', file: options.lockfilePath },
      );
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  // Local work queues behind its owner instead of spending filesystem retries
  // while that same process captures, repairs or collects another run's bytes.
  // A failed operation still rejects its caller; the next operation can proceed.
  const previous = bundleLockQueues.get(options.lockfilePath) ?? Promise.resolve();
  const pending = previous.then(execute, execute);
  bundleLockQueues.set(options.lockfilePath, pending);
  try {
    return await pending;
  } finally {
    if (bundleLockQueues.get(options.lockfilePath) === pending)
      bundleLockQueues.delete(options.lockfilePath);
  }
}

function bundleLockOptions(store: RunBundleStore, name: string) {
  return { lockfilePath: path.join(store.runsDir, name), realpath: false, stale: 30_000 };
}

function repairLockName(digest: string): string {
  return `bundle-repair-${digest}.lock`;
}

/** A `missingData` entry is `<reason>:<task-relative path>`, e.g. `media-capacity:artifacts/a.mp4`. */
export function parseRunBundleMissingData(entry: string): { reason: string; path: string } {
  const split = entry.indexOf(':');
  return split < 0
    ? { reason: '', path: entry }
    : { reason: entry.slice(0, split), path: entry.slice(split + 1) };
}

export function isRunBundleMedia(file: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|m4v|mp3|m4a|wav)$/iu.test(file);
}

// One awaited stat at a time cost ~5 ms each inside a busy gateway, so a walk over
// ~50k historical task files held run completion for 30+ minutes. Keep a bounded
// number of filesystem calls in flight instead.
const PHYSICAL_SCAN_CONCURRENCY = 64;

function concurrencyLimit(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A released slot passes straight to the next waiter, so `active` never exceeds max.
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

async function physicalBytes(root: string, scan?: AcquisitionScan): Promise<number> {
  const limit = concurrencyLimit(PHYSICAL_SCAN_CONCURRENCY);
  const walk = async (directory: string): Promise<number> => {
    let entries;
    try {
      entries = await limit(() => readdir(directory, { withFileTypes: true }));
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return 0;
      throw error;
    }
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(file);
        if (!entry.isFile()) return 0;
        try {
          return (
            await limit(() => {
              if (scan) scan.fileCount++;
              return stat(file);
            })
          ).size;
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
          return 0;
        }
      }),
    );
    return sizes.reduce((total, size) => total + size, 0);
  };
  return walk(root);
}

/**
 * A published bundle charges its recorded bytes. Every change to a bundle directory
 * happens under the store lock and records its new size there, so admission reads
 * one small file per bundle instead of stat-ing every payload in the store.
 */
const BUNDLE_DIGEST = /^[a-f0-9]{64}$/;

function bundleUsagePath(store: RunBundleStore, digest: string): string {
  return path.join(store.root, 'usage', `${digest}.json`);
}

async function recordBundleBytes(store: RunBundleStore, digest: string, bytes: number) {
  await atomicJson(bundleUsagePath(store, digest), { bytes });
}

async function readBundleRecord(store: RunBundleStore, digest: string) {
  const raw = await readOptional(bundleUsagePath(store, digest));
  const bytes: unknown = raw && (JSON.parse(raw) as { bytes?: unknown }).bytes;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

async function recordedBundleBytes(store: RunBundleStore, digest: string): Promise<number> {
  const recorded = await readBundleRecord(store, digest);
  if (recorded !== undefined) return recorded;
  // Published before the record existed: measured once, then kept current.
  const measured = await physicalBytes(bundleDirectory(store, digest));
  await recordBundleBytes(store, digest, measured);
  return measured;
}

/**
 * Retention moves a bundle aside (`.retention-<uuid>`) while it archives it, and those bytes
 * stay charged until the archive removes them. Its manifest still names the bundle, so the
 * record applies; only a directory without one is measured.
 */
async function movedBundleBytes(store: RunBundleStore, directory: string): Promise<number> {
  const manifest = await readOptional(path.join(directory, 'manifest.json'));
  const recorded = manifest && (await readBundleRecord(store, sha256Text(manifest)));
  return typeof recorded === 'number' ? recorded : physicalBytes(directory);
}

/** A transfer stage charges its reserved ceiling, including partially written bytes, once. */
async function chargedStoreBytes(store: RunBundleStore): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(store.root, { withFileTypes: true })) {
    const file = path.join(store.root, entry.name);
    if (entry.name === 'sha256' && entry.isDirectory()) {
      for (const name of await readdir(file))
        bytes += BUNDLE_DIGEST.test(name)
          ? await recordedBundleBytes(store, name)
          : await movedBundleBytes(store, path.join(file, name));
      continue;
    }
    // Records are bookkeeping for the bundles above, not stored payload.
    if (entry.name === 'usage') continue;
    if (entry.name !== 'staging' || !entry.isDirectory()) {
      bytes += entry.isDirectory() ? await physicalBytes(file) : (await stat(file)).size;
      continue;
    }
    for (const stage of await readdir(file)) {
      const directory = path.join(file, stage);
      const actual = await physicalBytes(directory);
      let reserved = 0;
      try {
        reserved = (await stat(path.join(directory, '.reservation'))).size;
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      bytes += Math.max(reserved, actual - reserved);
    }
  }
  return bytes;
}

const acquisitionScans = new Map<string, Promise<AcquisitionScan>>();
// A busy gateway's complete acquisition inventory can exceed thirty seconds.
const ACQUISITION_ADMISSION_TIMEOUT_MS = 120_000;

/** Share only an in-flight scan, never a stale footprint or a separate accounting store. */
async function acquisitionBytes(root: string): Promise<AcquisitionScan> {
  let scan = acquisitionScans.get(root);
  if (!scan) {
    scan = scanAcquisitionBytes(root).finally(() => acquisitionScans.delete(root));
    acquisitionScans.set(root, scan);
  }
  return scan;
}

/** Count every gateway acquisition tree, including preserved media of archived/deleted runs. */
async function scanAcquisitionBytes(root: string): Promise<AcquisitionScan> {
  const started = performance.now();
  const scan: AcquisitionScan = { bytes: 0, fileCount: 0, durationMs: 0 };
  let bytes = 0;
  const layout = { farmslotRoot: root, projectsDir: resolveProjectsDir(root) };
  // A projects dir inside .sandbox (desktop validation) is charged once, not again below.
  const counted = new Set<string>();
  for (const { root: taskRoot } of await listProjectTaskRoots(layout)) {
    counted.add(path.resolve(taskRoot));
    bytes += await physicalBytes(taskRoot, scan);
  }
  const sandbox = async (directory: string): Promise<number> => {
    if (path.basename(directory) === ORCHESTRATOR_TASK_DIR)
      return counted.has(path.resolve(directory)) ? 0 : physicalBytes(directory, scan);
    let sum = 0;
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !shouldSkipBundleFilesystemEntry(entry.name, true))
          sum += await sandbox(path.join(directory, entry.name));
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    return sum;
  };
  scan.bytes = bytes + (await sandbox(path.join(root, '.sandbox')));
  scan.durationMs = performance.now() - started;
  return scan;
}

async function chargedCaptureBytes(
  request: MaterializeRunBundleRequest,
  acquisitionSize: number,
): Promise<number> {
  return (
    (await chargedStoreBytes(request.store)) +
    (await reservedMetadataBytes(request.store, request.run.id)) +
    acquisitionSize +
    (request.stagingBytes ?? 0)
  );
}

async function reservedMetadataBytes(store: RunBundleStore, exceptRunId?: string): Promise<number> {
  const root = path.join(store.root, 'reservations');
  await mkdir(root, { recursive: true });
  let bytes = 0;
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json') || name === `${exceptRunId}.json`) continue;
    const reservation: { bytes: number } = JSON.parse(
      await readFile(path.join(root, name), 'utf8'),
    );
    if (!Number.isSafeInteger(reservation.bytes) || reservation.bytes < 0)
      throw new Error('Invalid retained metadata reservation.');
    bytes += reservation.bytes;
  }
  return bytes;
}

export interface RunBundleReference {
  ref: RunArtifactBundleRef;
  /** The decision whose captured snapshot this is; absent for the run's own bundles. */
  decision?: RunDecision;
}

/** Every bundle a run references, each decision's with the decision that captured it. */
export function runBundleRefs(run: Run): RunBundleReference[] {
  const refs: RunBundleReference[] = [];
  if (run.artifactBundle) refs.push({ ref: run.artifactBundle });
  if (run.output?.artifactBundle) refs.push({ ref: run.output.artifactBundle });
  for (const decision of run.decisions) {
    const ref = decisionArtifactBundleRef(run, decision.payload);
    if (ref) refs.push({ ref, decision });
  }
  return refs;
}

/** Resolve target-owned imported bytes without rewriting the receipt's original identity. */
export function resolveRetainedRunBundleRef(
  run: Run,
  ref: RunArtifactBundleRef,
): RunArtifactBundleRef {
  return run.importProvenance?.artifactBundleRefs?.[ref.bundleDigest] ?? ref;
}

/** Reserve lightweight output capacity before starting work, under the capture/GC lock. */
export async function reserveRunBundleMetadata(
  store: RunBundleStore,
  runId: string,
  policy = DEFAULT_RUN_BUNDLE_RETENTION,
  farmslotRoot?: string,
): Promise<void> {
  await assertStorePairing(store);
  assertSafeBundleSegment(runId, 'run id');
  assertPolicy(policy);
  const file = path.join(store.root, 'reservations', `${runId}.json`);
  // Replay/resume does not admit new work. Do not rescan historical task inputs for it.
  if (await readOptional(file)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const acquisitionSize = farmslotRoot
    ? await Promise.race([
        acquisitionBytes(farmslotRoot).then((scan) => scan.bytes),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Retention admission acquisition scan timed out after ${ACQUISITION_ADMISSION_TIMEOUT_MS}ms for run ${runId}`,
                ),
              ),
            ACQUISITION_ADMISSION_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer))
    : 0;
  // Only the read-only scan is raced. A timed-out scan cannot later reserve or start work.
  return withRunBundleStoreLock(store, async () => {
    if (await readOptional(file)) return;
    const bytes = Math.min(1024 ** 2, policy.metadataReserveBytes);
    const reserved = await reservedMetadataBytes(store);
    if (
      bytes === 0 ||
      reserved + bytes > policy.metadataReserveBytes ||
      (await chargedStoreBytes(store)) + reserved + bytes + acquisitionSize > policy.maxStoreBytes
    )
      throw new Error(
        'Retained report metadata capacity is exhausted; free storage before starting work.',
      );
    await atomicJson(file, { runId, bytes, createdAt: new Date().toISOString() });
  });
}

function assertPolicy(policy: RunBundleRetentionPolicy): void {
  if (
    Object.values(policy).some((value) => !Number.isFinite(value) || value < 0) ||
    policy.maxBundleBytes === 0 ||
    policy.maxStoreBytes <= policy.metadataReserveBytes
  )
    throw new Error('Invalid runBundleRetention capacity policy.');
}

async function copyHashed(
  source: string,
  dest: string | null,
  maxBytes: number,
): Promise<RunBundlePayloadIdentity> {
  if (dest) await mkdir(path.dirname(dest), { recursive: true });
  const digest = createHash('sha256');
  let bytes = 0;
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await pipeline(
      handle.createReadStream(),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes)
            return callback(new Error('Run bundle file exceeded its reserved capacity.'));
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      dest
        ? createWriteStream(dest, { flags: 'wx', mode: 0o600, flush: true })
        : new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
    );
  } finally {
    await handle.close();
  }
  if (dest) await chmod(dest, 0o400);
  return { sha256: digest.digest('hex'), bytes };
}

function bundleDirectory(store: RunBundleStore, digest: string): string {
  if (!BUNDLE_DIGEST.test(digest)) throw new Error('Invalid retained bundle digest.');
  return path.join(store.root, 'sha256', digest);
}

function recordExpectedArtifact(
  manifest: RunBundleManifest,
  taskKey: string,
  artifact: ArtifactRef,
  bytes = artifact.sizeBytes,
): void {
  if (!artifact.sha256 || bytes === undefined) return;
  const key = `tasks/${taskKey}/${artifact.path}`;
  manifest.entries[key] = { path: key, sha256: artifact.sha256.replace(/^sha256:/u, ''), bytes };
}

async function assertStorePairing(store: RunBundleStore): Promise<void> {
  const binding = await openRunBundleStore({
    runsDir: store.runsDir,
    home: path.dirname(store.root),
  });
  if (binding.id !== store.id || binding.root !== store.root)
    throw new Error('Run bundle store pairing changed.');
}

const manifestCache = new Map<string, RunBundleManifest>();

async function completeRetainedPayloads(
  request: MaterializeRunBundleRequest,
  ref: RunArtifactBundleRef,
  directory: string,
  manifest: RunBundleManifest,
  acquisitionSize: number,
): Promise<string[]> {
  const policy = request.policy ?? DEFAULT_RUN_BUNDLE_RETENTION;
  // The capture-scoped lock excludes another repair. Global admission remains free during IO.
  const repairStage = path.join(request.store.root, 'staging', ref.bundleDigest);
  await withRunBundleStoreLock(request.store, async () => {
    await rm(repairStage, { recursive: true, force: true });
    await mkdir(repairStage, { recursive: true });
  });
  const reservation = path.join(repairStage, '.reservation');
  const prefix = `tasks/${ref.taskKey}/`;
  const missing = (manifest.missingData ?? []).filter((entry) => {
    const { reason, path: relative } = parseRunBundleMissingData(entry);
    return (
      (reason !== 'missing' && reason !== 'media-capacity') ||
      !manifest.entries[`${prefix}${relative}`]
    );
  });
  const restored = new Set<string>();
  try {
    const pending: Array<[string, RunBundleManifest['entries'][string]]> = [];
    for (const [key, meta] of Object.entries(manifest.entries)) {
      if (!key.startsWith(prefix)) continue;
      const target = resolvePathInsideRoot(directory, key);
      try {
        await stat(target);
        continue;
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      pending.push([key, meta]);
    }
    let remaining = 0;
    const admitted = await withRunBundleStoreLock(request.store, async () => {
      const selected: typeof pending = [];
      if (!pending.length) return selected;
      // The presence check above already says which manifest entries are on disk, so the
      // bundle's bytes follow from the manifest; this also corrects a record a crash left stale.
      const pendingKeys = new Set(pending.map(([key]) => key));
      let present = (await stat(path.join(directory, 'manifest.json'))).size;
      for (const [key, meta] of Object.entries(manifest.entries))
        if (!pendingKeys.has(key)) present += meta.bytes;
      await recordBundleBytes(request.store, ref.bundleDigest, present);
      let storeAvailable =
        policy.maxStoreBytes - (await chargedCaptureBytes(request, acquisitionSize));
      let bundleAvailable = policy.maxBundleBytes - present;
      for (const [key, meta] of pending) {
        const relative = key.slice(prefix.length);
        const reserve = isRunBundleMedia(relative) ? policy.metadataReserveBytes : 0;
        if (meta.bytes > Math.min(storeAvailable - reserve, bundleAvailable)) {
          missing.push(`media-capacity:${relative}`);
          continue;
        }
        selected.push([key, meta]);
        storeAvailable -= meta.bytes;
        bundleAvailable -= meta.bytes;
        remaining += meta.bytes;
      }
      if (selected.length) {
        // Reserve the complete transfer once, including its partially written bytes.
        const handle = await open(reservation, 'wx', 0o600);
        try {
          await handle.truncate(remaining);
        } finally {
          await handle.close();
        }
      }
      return selected;
    });
    // Called under the store lock with the payload commit or failed-transfer cleanup.
    const consumeReservation = async (bytes: number) => {
      const next = remaining - bytes;
      if (!next) await rm(reservation, { force: true });
      else {
        const handle = await open(reservation, 'r+');
        try {
          await handle.truncate(next);
        } finally {
          await handle.close();
        }
      }
      remaining = next;
    };
    for (const [key, meta] of admitted) {
      const relative = key.slice(prefix.length);
      const target = resolvePathInsideRoot(directory, key);
      const temp = path.join(repairStage, `${randomUUID()}.tmp`);
      try {
        let copied: RunBundlePayloadIdentity;
        if (request.acquireMedia && isRunBundleMedia(relative)) {
          copied = await request.acquireMedia(
            { path: relative, purpose: 'artifact', sha256: meta.sha256, sizeBytes: meta.bytes },
            temp,
            meta.bytes,
          );
        } else {
          const root = request.gatewayFiles?.paths.includes(relative)
            ? request.gatewayFiles.taskDir
            : request.taskDir;
          const source = resolvePathInsideRoot(await realpath(root), relative);
          if ((await realpath(source)) !== source)
            throw new Error('Retained repair source is redirected.');
          copied = await copyHashed(source, temp, meta.bytes);
        }
        await withRunBundleStoreLock(request.store, async () => {
          if (copied.sha256 !== meta.sha256 || copied.bytes !== meta.bytes) {
            missing.push(`changed:${relative}`);
            await rm(temp, { force: true });
          } else {
            await chmod(temp, 0o400);
            await syncPath(temp);
            await mkdir(path.dirname(target), { recursive: true });
            // Charged before it is visible: a crash or failed rename over-counts until
            // the next repair admission re-derives the record, never under-counts.
            await recordBundleBytes(
              request.store,
              ref.bundleDigest,
              (await recordedBundleBytes(request.store, ref.bundleDigest)) + meta.bytes,
            );
            await rename(temp, target);
            await syncPath(path.dirname(target));
            restored.add(key);
          }
          await consumeReservation(meta.bytes);
        });
      } catch (error) {
        await withRunBundleStoreLock(request.store, async () => {
          await rm(temp, { force: true });
          await consumeReservation(meta.bytes);
        });
        if (!hasCode(error, 'ENOENT')) throw error;
        missing.push(`missing:${relative}`);
      }
    }
    await withRunBundleStoreLock(request.store, async () => {
      if (!restored.size) return;
      await readRetainedRunBundle(request.store, ref, request.run.id);
      const file = path.join(request.store.root, 'availability', `${ref.bundleDigest}.json`);
      const prior = await readOptional(file);
      const availability: RunBundleAvailability = prior
        ? JSON.parse(prior)
        : { revision: 0, prunedPaths: [] };
      await atomicJson(file, {
        revision: availability.revision + 1,
        prunedPaths: availability.prunedPaths.filter((key) => !restored.has(key)),
      });
    });
    return missing;
  } finally {
    await withRunBundleStoreLock(request.store, () =>
      rm(repairStage, { recursive: true, force: true }),
    );
  }
}

async function commitRetainedPayloads(
  request: MaterializeRunBundleRequest,
  ref: RunArtifactBundleRef,
  directory: string,
  manifest: RunBundleManifest,
): Promise<string[]> {
  await readRetainedRunBundle(request.store, ref, request.run.id);
  const prefix = `tasks/${ref.taskKey}/`;
  const unavailable = [...(manifest.missingData ?? [])];
  for (const key of Object.keys(manifest.entries)) {
    if (!key.startsWith(prefix)) continue;
    try {
      await stat(resolvePathInsideRoot(directory, key));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      unavailable.push(`missing:${key.slice(prefix.length)}`);
    }
  }
  // The report has a durable, readable identity before any bulk transport starts.
  await request.commit(ref, [...new Set(unavailable)]);
  return [...new Set(unavailable)];
}

export async function readRunBundleAvailability(
  store: RunBundleStore,
  ref: RunArtifactBundleRef,
  runId: string,
): Promise<RunBundleAvailability> {
  await readRetainedRunBundle(store, ref, runId);
  const raw = await readOptional(path.join(store.root, 'availability', `${ref.bundleDigest}.json`));
  return raw ? JSON.parse(raw) : { revision: 0, prunedPaths: [] };
}

export async function readRetainedRunBundle(
  store: RunBundleStore,
  ref: RunArtifactBundleRef,
  runId: string,
): Promise<RetainedRunBundleSnapshot> {
  await assertStorePairing(store);
  if (store.id !== ref.storeId) throw new Error('Retained bundle belongs to another Run store.');
  assertSafeBundleSegment(ref.taskKey, 'task key');
  const directory = bundleDirectory(store, ref.bundleDigest);
  const cacheKey = `${store.id}:${ref.bundleDigest}`;
  // Parsed metadata may be cached; the published manifest must still exist and match.
  const raw = await readFile(path.join(directory, 'manifest.json'), 'utf8');
  if (sha256Text(raw) !== ref.bundleDigest)
    throw new Error('Retained bundle manifest digest mismatch.');
  let manifest = manifestCache.get(cacheKey);
  if (!manifest) {
    manifest = parseManifest(directory);
    for (const [key, meta] of Object.entries(manifest.entries)) {
      assertSafeBundleRelativePath(key);
      if (
        meta.path !== key ||
        !/^[a-f0-9]{64}$/u.test(meta.sha256) ||
        !Number.isSafeInteger(meta.bytes) ||
        meta.bytes < 0
      )
        throw new Error('Invalid retained bundle manifest entry.');
    }
    if (manifestCache.size >= 128) manifestCache.delete(manifestCache.keys().next().value!);
    manifestCache.set(cacheKey, manifest);
  }
  if (
    !manifest.runs.some((entry) => entry.originalRunId === runId && entry.taskKey === ref.taskKey)
  )
    throw new Error('Retained bundle does not belong to this run.');
  const retainedManifest = manifest;
  const resolveEntry = async (relativePath: string): Promise<ResolvedRunBundleEntry> => {
    assertSafeBundleRelativePath(relativePath);
    const key = `tasks/${ref.taskKey}/${relativePath}`;
    const meta = retainedManifest.entries[key];
    if (!meta)
      throw new Error(
        `Artifact was not retained: ${relativePath}. Run farmslot runs bundle retain ${runId}.`,
      );
    const file = resolvePathInsideRoot(directory, key);
    let real: string;
    try {
      real = await realpath(file);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      // The capture declared why it kept no payload; name it instead of a bare ENOENT.
      const declared = (retainedManifest.missingData ?? [])
        .map(parseRunBundleMissingData)
        .find((entry) => entry.path === relativePath);
      throw Object.assign(
        new Error(
          declared
            ? `Artifact not retained (${declared.reason}): ${relativePath}`
            : `Retained artifact is missing, pruned or changed: ${relativePath}`,
        ),
        { code: 'ENOENT' },
      );
    }
    if (real !== file) throw new Error('Retained bundle contains a redirected path.');
    const info = await lstat(file);
    if (!info.isFile() || info.size !== meta.bytes)
      throw new Error(`Retained artifact is missing, pruned or changed: ${relativePath}`);
    return { path: file, sha256: meta.sha256, bytes: meta.bytes };
  };
  return {
    directory,
    taskDir: path.join(directory, 'tasks', ref.taskKey),
    manifest,
    resolveEntry,
    readText: async (file) => {
      const entry = await resolveEntry(file);
      const bytes = await readFile(entry.path);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new Error(`Retained artifact bytes changed: ${file}`);
      return bytes.toString('utf8');
    },
  };
}

/** Preserve history metadata and pinned dependency media; availability is separate from the manifest. */
export interface RunBundleHousekeepingPath {
  path: string;
  runId: string;
  store: 'bundle-reservations' | 'bundle-intents' | 'bundle-staging';
}

/** Metadata/staging selection shared by the standalone collector and archive-only gateway. Caller holds the bundle lock. */
async function runBundleHousekeepingInventory(store: RunBundleStore, now: number) {
  const cleanup: RunBundleHousekeepingPath[] = [];
  const referenced = new Set<string>();
  const activeRuns = new Set<string>();
  const pinned = new Set<string>();
  const retainReference = (ref: RunArtifactBundleRef | undefined, pin: boolean) => {
    if (!ref || ref.storeId !== store.id) return;
    referenced.add(ref.bundleDigest);
    if (pin) pinned.add(ref.bundleDigest);
  };
  for (const run of [
    ...loadAllRunRecords(store.runsDir),
    ...loadAllRunRecords(path.join(store.runsDir, 'archive')),
  ]) {
    const retain = (ref: RunArtifactBundleRef | undefined, pin: boolean) =>
      retainReference(ref ? resolveRetainedRunBundleRef(run, ref) : undefined, pin);
    const active = isActiveListRun(run);
    if (active) activeRuns.add(run.id);
    for (const { ref, decision } of runBundleRefs(run))
      retain(
        ref,
        decision
          ? !decision.resolvedAt ||
              (decision.payload?.kind === 'ready' &&
                ['published_draft', 'published_ready'].includes(
                  decision.payload.prPackage?.publicationStatus ?? '',
                ))
          : active,
      );
  }
  const intentsDir = path.join(store.runsDir, 'bundle-intents');
  await mkdir(intentsDir, { recursive: true });
  const activeStages = new Set<string>();
  const captureRuns = new Set<string>();
  const committedIntents = new Map<string, string[]>();
  for (const file of await readdir(intentsDir)) {
    if (!file.endsWith('.json')) continue;
    const intentPath = path.join(intentsDir, file);
    const intent: CaptureIntent = JSON.parse(await readFile(intentPath, 'utf8'));
    // A prepared package can outlive the current output pointer before its gate is recorded.
    if (intent.bundleDigest && activeRuns.has(intent.runId)) pinned.add(intent.bundleDigest);
    if (intent.committed && intent.bundleDigest) {
      const files = committedIntents.get(intent.bundleDigest) ?? [];
      files.push(path.join(intentsDir, file));
      committedIntents.set(intent.bundleDigest, files);
    }
    if (!intent.committed) {
      const inactive = now - (await stat(intentPath)).mtimeMs > 86_400_000;
      const repair = intent.bundleDigest
        ? bundleLockOptions(store, repairLockName(intent.bundleDigest))
        : null;
      const repairing = repair ? await lockfile.check(repair.lockfilePath, repair) : false;
      if (!activeRuns.has(intent.runId) && inactive && !repairing) {
        cleanup.push({ path: intentPath, runId: intent.runId, store: 'bundle-intents' });
        continue;
      }
      activeStages.add(intent.bundleId);
      if (intent.bundleDigest) activeStages.add(intent.bundleDigest);
      captureRuns.add(intent.runId);
      if (intent.bundleDigest) pinned.add(intent.bundleDigest);
    }
  }
  const reservations = path.join(store.root, 'reservations');
  await mkdir(reservations, { recursive: true });
  for (const name of await readdir(reservations)) {
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -5);
    if (!activeRuns.has(runId) && !captureRuns.has(runId))
      cleanup.push({ path: path.join(reservations, name), runId, store: 'bundle-reservations' });
  }
  const stagingRoot = path.join(store.root, 'staging');
  await mkdir(stagingRoot, { recursive: true });
  for (const name of await readdir(stagingRoot)) {
    if (name.startsWith('.retention-')) continue;
    assertSafeBundleSegment(name, 'staging id');
    const directory = path.join(stagingRoot, name);
    if (activeStages.has(name) || now - (await stat(directory)).mtimeMs < 86_400_000) continue;
    cleanup.push({ path: directory, runId: 'bundle-housekeeping', store: 'bundle-staging' });
  }
  return { cleanup, referenced, pinned, committedIntents };
}

/** Select inactive reservations and abandoned capture scaffolding without removing bytes. */
export async function runBundleHousekeepingPaths(
  store: RunBundleStore,
  now = Date.now(),
): Promise<RunBundleHousekeepingPath[]> {
  await assertStorePairing(store);
  return (await runBundleHousekeepingInventory(store, now)).cleanup;
}

export async function collectRunBundleGarbage(
  store: RunBundleStore,
  policy = DEFAULT_RUN_BUNDLE_RETENTION,
  now = Date.now(),
): Promise<{ reclaimedBytes: number; prunedPaths: string[] }> {
  await assertStorePairing(store);
  assertPolicy(policy);
  return withRunBundleStoreLock(store, async () => {
    const { cleanup, referenced, pinned, committedIntents } = await runBundleHousekeepingInventory(
      store,
      now,
    );
    let housekeepingBytes = 0;
    for (const entry of cleanup) {
      if (entry.store === 'bundle-staging') housekeepingBytes += await physicalBytes(entry.path);
      await rm(entry.path, { recursive: true, force: true });
    }
    let reclaimedBytes = housekeepingBytes;
    const prunedPaths: string[] = [];
    const digestRoot = path.join(store.root, 'sha256');
    await mkdir(digestRoot, { recursive: true });
    for (const digest of await readdir(digestRoot)) {
      const directory = bundleDirectory(store, digest);
      if (pinned.has(digest)) continue;
      if (!referenced.has(digest)) {
        reclaimedBytes +=
          (await readBundleRecord(store, digest)) ?? (await physicalBytes(directory));
        await rm(directory, { recursive: true });
        await rm(bundleUsagePath(store, digest), { force: true });
        // A reclaimed payload cannot satisfy its old retry intent. Future explicit
        // acquisition of these bytes starts a new capture instead of a lost stage.
        for (const intent of committedIntents.get(digest) ?? []) await rm(intent);
        manifestCache.delete(`${store.id}:${digest}`);
        continue;
      }
      const manifest = parseManifest(directory);
      if (now - Date.parse(manifest.exportedAt) < policy.mediaRetentionDays * 86_400_000) continue;
      const removed: string[] = [];
      let prunedBytes = 0;
      const recorded = await readBundleRecord(store, digest);
      for (const [key, meta] of Object.entries(manifest.entries)) {
        if (!isRunBundleMedia(key)) continue;
        const file = resolvePathInsideRoot(directory, key);
        try {
          await rm(file);
          reclaimedBytes += meta.bytes;
          prunedBytes += meta.bytes;
          removed.push(key);
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
        }
      }
      if (removed.length) {
        await recordBundleBytes(
          store,
          digest,
          recorded === undefined
            ? await physicalBytes(directory)
            : Math.max(0, recorded - prunedBytes),
        );
        const record = path.join(store.root, 'availability', `${digest}.json`);
        const prior = await readOptional(record);
        const availability: { revision: number; prunedPaths: string[] } = prior
          ? JSON.parse(prior)
          : { revision: 0, prunedPaths: [] };
        await atomicJson(record, {
          revision: availability.revision + 1,
          prunedPaths: [...new Set([...availability.prunedPaths, ...removed])],
        });
        prunedPaths.push(...removed);
      }
    }
    return { reclaimedBytes, prunedPaths };
  });
}

/** Resolve only a listed, retained entry. No task tree scan, source lookup or archive extraction. */
export async function resolveRunBundleEntry(input: {
  store: RunBundleStore;
  ref: RunArtifactBundleRef;
  runId: string;
  path: string;
}): Promise<ResolvedRunBundleEntry> {
  const bundle = await readRetainedRunBundle(input.store, input.ref, input.runId);
  return bundle.resolveEntry(input.path);
}

/** Materialize farmrun v1 from one captured inventory, then fence its Run reference under the lock. */
export async function materializeRunBundle(
  request: MaterializeRunBundleRequest,
): Promise<MaterializedRunBundle> {
  const { store, run } = request;
  assertSafeBundleSegment(run.id, 'run id');
  await assertStorePairing(store);
  const policy = request.policy ?? DEFAULT_RUN_BUNDLE_RETENTION;
  assertPolicy(policy);
  const acquisitionScan = await acquisitionBytes(request.farmslotRoot);
  const acquisitionSize = acquisitionScan.bytes;
  const captured = await withRunBundleStoreLock(store, async () => {
    const taskKey = run.id;
    const intentPath = path.join(
      store.runsDir,
      'bundle-intents',
      `${sha256Text(`${run.id}:${request.captureKey}`)}.json`,
    );
    let prior = await readOptional(intentPath);
    if (!prior && request.existingRef) {
      if (request.existingRef.manifestDigest !== request.manifestDigest)
        throw new Error('Existing retained capture has a different output identity.');
      const retained = await readRetainedRunBundle(store, request.existingRef, run.id);
      const original: CaptureIntent = {
        runId: run.id,
        key: request.captureKey,
        bundleId: retained.manifest.bundleId,
        exportedAt: retained.manifest.exportedAt,
        runJson: '',
        bundleDigest: request.existingRef.bundleDigest,
      };
      await atomicJson(intentPath, original);
      prior = JSON.stringify(original);
    }
    const intent: CaptureIntent = prior
      ? JSON.parse(prior)
      : {
          runId: run.id,
          key: request.captureKey,
          bundleId: randomUUID(),
          exportedAt: new Date().toISOString(),
          runJson: `${JSON.stringify(sanitizeRunForBundleExport(run, 'reference'), null, 2)}\n`,
        };
    if (intent.key !== request.captureKey) throw new Error('Run bundle capture intent changed.');
    if (!prior) await atomicJson(intentPath, intent);
    if (intent.bundleDigest) {
      const ref: RunArtifactBundleRef = {
        storeId: store.id,
        bundleDigest: intent.bundleDigest,
        taskKey,
        manifestDigest: request.manifestDigest,
      };
      const destination = bundleDirectory(store, intent.bundleDigest);
      if (!(await readOptional(path.join(destination, 'manifest.json')))) {
        const stage = path.join(store.root, 'staging', intent.bundleId);
        const raw = await readFile(path.join(stage, 'manifest.json'), 'utf8');
        if (sha256Text(raw) !== intent.bundleDigest)
          throw new Error('Interrupted retained capture is corrupt.');
        await recordBundleBytes(store, intent.bundleDigest, await physicalBytes(stage));
        await rename(stage, destination);
        await syncPath(path.dirname(destination));
      }
      const retained = await readRetainedRunBundle(store, ref, run.id);
      const missingData = await commitRetainedPayloads(
        request,
        ref,
        retained.directory,
        retained.manifest,
      );
      intent.committed = false;
      intent.runJson = '';
      await atomicJson(intentPath, intent);
      await rm(path.join(store.root, 'reservations', `${run.id}.json`), { force: true });
      return { ref, manifest: retained.manifest, missingData };
    }
    const stage = path.join(store.root, 'staging', intent.bundleId);
    // A crashed pre-publication copy has no committed reference and can be restarted.
    await rm(stage, { recursive: true, force: true });
    await mkdir(path.join(stage, 'runs'), { recursive: true });
    await mkdir(path.join(stage, 'tasks', taskKey), { recursive: true });
    const runPath = `runs/${run.id}.json`;
    const manifest: RunBundleManifest = {
      version: RUN_BUNDLE_VERSION,
      profile: 'reference',
      exportedAt: intent.exportedAt,
      bundleId: intent.bundleId,
      source: { farmslotRoot: request.farmslotRoot, runIds: [run.id] },
      remapPolicy: 'preserve-ids',
      runs: [
        {
          originalRunId: run.id,
          runPath,
          taskKey,
          taskRelativePath:
            strictTaskRelativePathFromFarmslotRoot(request.farmslotRoot, run.taskFile) ?? undefined,
        },
      ],
      entries: {
        [runPath]: {
          path: runPath,
          sha256: sha256Text(intent.runJson),
          bytes: Buffer.byteLength(intent.runJson),
        },
      },
    };
    const missingData: string[] = [];
    let bundleBytes = Buffer.byteLength(intent.runJson);
    let stagedBytes = bundleBytes;
    let storeBytes = await chargedCaptureBytes(request, acquisitionSize);
    const taskRoot = await realpath(request.taskDir);
    const gatewayRoot = request.gatewayFiles && (await realpath(request.gatewayFiles.taskDir));
    const gatewayPaths = new Set(request.gatewayFiles?.paths);
    const ordered = [...request.artifacts].sort(
      (a, b) =>
        Number(isRunBundleMedia(a.path)) - Number(isRunBundleMedia(b.path)) ||
        a.path.localeCompare(b.path),
    );
    const manifestReserve =
      Buffer.byteLength(JSON.stringify(ordered)) + ordered.length * 300 + 4096;
    try {
      for (const artifact of ordered) {
        assertSafeBundleRelativePath(artifact.path);
        if (
          artifact.path
            .split('/')
            .some((segment) => shouldSkipBundleFilesystemEntry(segment, false))
        ) {
          missingData.push(`excluded:${artifact.path}`);
          continue;
        }
        const source = resolvePathInsideRoot(
          gatewayRoot && gatewayPaths.has(artifact.path) ? gatewayRoot : taskRoot,
          artifact.path,
        );
        let size: number;
        try {
          if ((await realpath(source)) !== source || !(await lstat(source)).isFile())
            throw new Error(`Artifact is redirected: ${artifact.path}`);
          size = (await stat(source)).size;
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
          recordExpectedArtifact(manifest, taskKey, artifact);
          if (
            request.acquireMedia &&
            isRunBundleMedia(artifact.path) &&
            artifact.sha256 &&
            artifact.sizeBytes !== undefined
          ) {
            size = artifact.sizeBytes;
          } else {
            missingData.push(`missing:${artifact.path}`);
            continue;
          }
        }
        const media = isRunBundleMedia(artifact.path);
        const expected =
          media && !artifact.sha256
            ? { ...artifact, sha256: (await copyHashed(source, null, size)).sha256 }
            : artifact;
        // Keep manifest overhead and the protected report/metadata reserve ahead of media.
        const available = Math.min(
          policy.maxBundleBytes - bundleBytes - manifestReserve,
          policy.maxStoreBytes -
            storeBytes -
            manifestReserve -
            (media ? policy.metadataReserveBytes : 0),
        );
        if (size > available) {
          if (!media)
            throw new Error(
              'Run bundle metadata capacity exhausted; free storage or raise gateway retention limits.',
            );
          recordExpectedArtifact(manifest, taskKey, expected, size);
          missingData.push(`media-capacity:${artifact.path}`);
          continue;
        }
        if (media) {
          recordExpectedArtifact(manifest, taskKey, expected, size);
          bundleBytes += size;
          storeBytes += size;
          continue;
        }
        const key = `tasks/${taskKey}/${artifact.path}`;
        const copied = await copyHashed(source, path.join(stage, key), Math.min(size, available));
        if (artifact.sha256 && copied.sha256 !== artifact.sha256.replace(/^sha256:/u, '')) {
          if (!request.allowChanged)
            throw new Error(`Captured artifact changed while retaining: ${artifact.path}`);
          missingData.push(`changed:${artifact.path}`);
        }
        manifest.entries[key] = { path: key, ...copied };
        bundleBytes += copied.bytes;
        stagedBytes += copied.bytes;
        storeBytes += copied.bytes;
      }
      if (missingData.length) manifest.missingData = missingData;
      const raw = `${JSON.stringify(manifest, null, 2)}\n`;
      if (
        bundleBytes + Buffer.byteLength(raw) > policy.maxBundleBytes ||
        storeBytes + Buffer.byteLength(raw) > policy.maxStoreBytes
      )
        throw new Error('Run bundle manifest exceeds reserved capacity.');
      await writeFile(path.join(stage, runPath), intent.runJson, { mode: 0o400, flush: true });
      await writeFile(path.join(stage, 'manifest.json'), raw, { mode: 0o400, flush: true });
      await syncPath(path.join(stage, 'runs'));
      await syncPath(stage);
      const bundleDigest = sha256Text(raw);
      const destination = bundleDirectory(store, bundleDigest);
      await mkdir(path.dirname(destination), { recursive: true });
      // Persist identity before publishing, so a crash in the reference commit reuses it.
      intent.bundleDigest = bundleDigest;
      await atomicJson(intentPath, intent);
      await recordBundleBytes(store, bundleDigest, stagedBytes + Buffer.byteLength(raw));
      await rename(stage, destination);
      await syncPath(path.dirname(destination));
      const ref: RunArtifactBundleRef = {
        storeId: store.id,
        bundleDigest,
        taskKey,
        manifestDigest: request.manifestDigest,
      };
      const remaining = await commitRetainedPayloads(request, ref, destination, manifest);
      intent.committed = false;
      intent.runJson = '';
      await atomicJson(intentPath, intent);
      await rm(path.join(store.root, 'reservations', `${run.id}.json`), { force: true });
      return { ref, manifest, missingData: remaining };
    } catch (error) {
      // Keep a published capture pinned by its persisted intent until commit/recovery.
      if (!intent.bundleDigest) await rm(stage, { recursive: true, force: true });
      throw error;
    }
  });
  return withBundleLock(store, repairLockName(captured.ref.bundleDigest), async () => {
    const missingData = await completeRetainedPayloads(
      request,
      captured.ref,
      bundleDirectory(store, captured.ref.bundleDigest),
      captured.manifest,
      acquisitionSize,
    );
    return withRunBundleStoreLock(store, async () => {
      await readRetainedRunBundle(store, captured.ref, run.id);
      await request.commit(captured.ref, missingData);
      const intentPath = path.join(
        store.runsDir,
        'bundle-intents',
        `${sha256Text(`${run.id}:${request.captureKey}`)}.json`,
      );
      const intent: CaptureIntent = JSON.parse(await readFile(intentPath, 'utf8'));
      intent.committed = true;
      intent.runJson = '';
      await atomicJson(intentPath, intent);
      return { ...captured, missingData, acquisitionScan };
    });
  });
}
