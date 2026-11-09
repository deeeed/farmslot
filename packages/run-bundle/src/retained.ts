import { type FarmPaths, resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, existsSync, readFileSync, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
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
import { homedir } from 'node:os';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import lockfile from 'proper-lockfile';

import {
  type ArtifactRef,
  decisionArtifactBundleRef,
  isActiveListRun,
  isRecord,
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
import {
  isRunBundleMedia,
  shouldSkipBundleFile,
  shouldSkipBundleFilesystemEntry,
} from './copy-tree.js';
import {
  captureDecisionHistoryPrefix,
  decisionHistoryFile,
  readDecisionHistoryFile,
} from './decision-history.js';
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

export interface RunBundleRetentionSettings {
  policy: RunBundleRetentionPolicy;
  storeRoot?: string;
}

function absoluteStoreRoot(root: string): string {
  const expanded =
    root === '~' ? homedir() : root.startsWith('~/') ? path.join(homedir(), root.slice(2)) : root;
  if (!path.isAbsolute(expanded)) throw new Error('runBundleRetention.storeRoot must be absolute.');
  return path.resolve(expanded);
}

function retentionDocument(home: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(
      path.join(resolveFarmPaths({ home, role: 'node' }).config, 'run-bundle-retention.json'),
      'utf8',
    );
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { runBundleRetention: {} };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !isRecord(value.runBundleRetention))
    throw new Error('Invalid runBundleRetention settings.');
  return value;
}

/** Configuration stays in the owning home even when the heavy store lives on another volume. */
export function runBundleRetentionSettings(home: string): RunBundleRetentionSettings {
  const document = retentionDocument(home);
  const settings = document.runBundleRetention;
  if (!isRecord(settings)) throw new Error('Invalid runBundleRetention settings.');
  const policy = { ...DEFAULT_RUN_BUNDLE_RETENTION };
  for (const key of Object.keys(policy) as Array<keyof RunBundleRetentionPolicy>) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value !== 'number') throw new Error(`Invalid runBundleRetention.${key}`);
    policy[key] = value;
  }
  if (settings.storeRoot !== undefined && typeof settings.storeRoot !== 'string')
    throw new Error('Invalid runBundleRetention.storeRoot.');
  return {
    policy,
    ...(settings.storeRoot === undefined
      ? {}
      : { storeRoot: absoluteStoreRoot(settings.storeRoot) }),
  };
}

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
  /** Journal prefix frozen with runJson; later appends belong to later captures. */
  decisionHistoryBytes?: number;
  /** The Run generation that captured it; earlier generations' packages are superseded. */
  generation?: number;
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
  /** Builds the classifier that lets settled task dirs be charged their kept footprint. */
  acquisitionTaskDirs?: AcquisitionTaskDirClassifier;
  /** Owning gateway's run archive root; media is moved here before capacity can defer it. */
  archiveRoot?: string;
  assertArchiveWriteRoom?: RunBundleMediaArchiveRequest['assertArchiveWriteRoom'];
  onMediaArchived?: (result: RunBundleMediaArchiveResult) => void;
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
  /** Settled task dirs charged their kept footprint without a walk. */
  settledDirs: number;
  durationMs: number;
}

/**
 * Classifies a gateway task dir (`<task root>/<flow>/<task>`) for acquisition accounting.
 * `undefined` means live: walked on every read. Any other value is a token that changes
 * whenever the dir may have changed; a settled dir is measured once per token and its
 * footprint kept in the store.
 */
export type AcquisitionTaskDirToken = (directory: string) => string | undefined;

/** Built only when a scan starts, so a caller that needs no scan pays nothing for it. */
export type AcquisitionTaskDirClassifier = () => Promise<AcquisitionTaskDirToken>;

export interface RunBundleAvailability {
  revision: number;
  prunedPaths: string[];
  /** Manifest entry key to a verified, durable archive file; older records omit this map. */
  archivedPaths?: Record<string, string>;
}

export interface RunBundleMediaArchiveResult {
  reclaimedBytes: number;
  archivedPaths: string[];
  pressure: boolean;
  chargedBytesBefore: number;
  chargedBytesAfter: number;
}

export interface RunBundleMediaArchiveRequest {
  store: RunBundleStore;
  farmslotRoot: string;
  archiveRoot: string;
  /** The host checks the destination volume's floor, including this copy's bytes. */
  assertArchiveWriteRoom?(root: string, copyBytes: number): Promise<void>;
  policy?: RunBundleRetentionPolicy;
  acquisitionTaskDirs?: AcquisitionTaskDirClassifier;
  now?: number;
}

// Start above the 70% warning, with a 15-point gap to leave capture headroom and avoid churn.
const RUN_BUNDLE_ARCHIVE_HIGH_RATIO = 0.85;
const RUN_BUNDLE_ARCHIVE_LOW_RATIO = 0.7;

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
  paths?: FarmPaths;
  runsDir: string;
  home: string;
  storeRoot?: string;
  create?: boolean;
}): Promise<RunBundleStore> {
  await mkdir(input.runsDir, { recursive: true });
  const runsDir = await realpath(input.runsDir);
  await recoverRunBundleMigration(runsDir);
  const configured =
    input.storeRoot === undefined
      ? runBundleRetentionSettings(input.home).storeRoot
      : absoluteStoreRoot(input.storeRoot);
  const bindingPath = path.join(runsDir, 'bundle-store.json');
  let raw = await readOptional(bindingPath);
  if (!raw) {
    if (!input.create)
      throw new Error('Run bundle store pairing is missing; start the owning gateway.');
    if (configured) await assertStoreRootParent(configured);
    const root =
      configured ??
      (input.paths ?? resolveFarmPaths({ role: 'node', home: input.home })).data.runBundles;
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
  if (configured) {
    const expected = await realpath(configured);
    const actual = configured === binding.root ? expected : await realpath(binding.root);
    if (expected !== actual)
      throw new Error(
        'Run bundle store pairing does not match the configured root; use the migration command.',
      );
  }
  const ownerPath = path.join(binding.root, 'store.json');
  let owner = await readOptional(ownerPath);
  if (
    !owner &&
    input.create &&
    binding.root === (await realpath(configured ?? path.join(input.home, 'run-bundles')))
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

async function assertStoreRootParent(root: string): Promise<void> {
  try {
    if ((await stat(root)).isDirectory()) return;
    throw new Error(`Run bundle configured root is not a directory: ${root}`);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  try {
    if ((await stat(path.dirname(root))).isDirectory()) return;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  throw new Error(
    `Run bundle configured root ${root} has a missing parent; is its volume mounted?`,
  );
}

const STORE_LOCK = 'bundle-store.lock';

/** One cross-process lock covers capacity reservations, commit and GC. */
export function withRunBundleStoreLock<T>(
  store: RunBundleStore,
  fn: () => Promise<T>,
  hold: BundleLockHold = {},
): Promise<T> {
  return withBundleLock(store, STORE_LOCK, hold, fn);
}

/**
 * What a holder declares about itself: waiters name it, and fail only once it has
 * held the lock past `holdLimitMs`. A long queue of healthy holders is not a stall.
 */
export interface BundleLockHold {
  label?: string;
  holdLimitMs?: number;
}

const bundleLockQueues = new Map<string, Promise<void>>();
const bundleLockHolders = new Map<string, { label: string; since: number; holdLimitMs: number }>();
// A healthy store-lock holder finishes in minutes even on a loaded gateway; a repair
// holds its own lock for a whole media transfer. Past these, waiters treat it as stalled.
const STORE_LOCK_HOLD_LIMIT_MS = 15 * 60_000;
const REPAIR_LOCK_HOLD_LIMIT_MS = 60 * 60_000;
const STALL_CHECK_MS = 10_000;
const SLOW_LOCK_WAIT_MS = 10_000;

/** True once `turn` resolves, false if `ms` passes first. */
function resolvedWithin(turn: Promise<true>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    turn,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Waits for `previous` (which never rejects); rejects once this process's holder is past its limit. */
async function waitForBundleLockTurn(
  previous: Promise<void>,
  lockfilePath: string,
  name: string,
  enqueuedAt: number,
): Promise<void> {
  const turn = previous.then(() => true as const);
  for (;;) {
    const holder = bundleLockHolders.get(lockfilePath);
    const untilStalled = holder
      ? holder.since + holder.holdLimitMs - Date.now() + 1
      : STALL_CHECK_MS;
    if (await resolvedWithin(turn, Math.max(1, Math.min(untilStalled, STALL_CHECK_MS)))) return;
    const current = bundleLockHolders.get(lockfilePath);
    if (!current || Date.now() - current.since <= current.holdLimitMs) continue;
    const message = `Run bundle lock ${name} has been held by ${current.label} for ${Math.round((Date.now() - current.since) / 1000)}s, past its ${Math.round(current.holdLimitMs / 1000)}s limit; gave up after waiting ${Math.round((Date.now() - enqueuedAt) / 1000)}s. Retry once it finishes.`;
    console.warn(`[run-bundle] ${message}`);
    throw Object.assign(new Error(message), { code: 'ELOCKED', file: lockfilePath });
  }
}

async function withBundleLock<T>(
  store: RunBundleStore,
  name: string,
  hold: BundleLockHold,
  fn: () => Promise<T>,
  checkPairing = true,
): Promise<T> {
  const options = bundleLockOptions(store, name);
  const enqueuedAt = Date.now();
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
    const holder = {
      label: hold.label ?? name,
      since: Date.now(),
      holdLimitMs: hold.holdLimitMs ?? STORE_LOCK_HOLD_LIMIT_MS,
    };
    const waited = holder.since - enqueuedAt;
    if (waited >= SLOW_LOCK_WAIT_MS)
      console.warn(
        `[run-bundle] ${holder.label} waited ${(waited / 1000).toFixed(1)}s for ${name}`,
      );
    bundleLockHolders.set(options.lockfilePath, holder);
    try {
      if (checkPairing && name === STORE_LOCK) {
        const migration = await readMigration(store.runsDir);
        if (migration?.phase === 'verified') await finishRunBundleMigration(migration);
        const current: RunBundleStore = JSON.parse(
          await readFile(path.join(store.runsDir, 'bundle-store.json'), 'utf8'),
        );
        if (current.id !== store.id || current.root !== store.root)
          throw new Error('Run bundle store pairing changed; reopen the store.');
      }
      return await fn();
    } finally {
      if (bundleLockHolders.get(options.lockfilePath) === holder)
        bundleLockHolders.delete(options.lockfilePath);
      await release();
    }
  };
  // Local work queues behind its owner instead of spending filesystem retries
  // while that same process captures, repairs or collects another run's bytes.
  // A failed or timed-out caller rejects alone: the queue tail settles only once
  // its predecessors have, so later callers still line up behind the holder.
  const previous = bundleLockQueues.get(options.lockfilePath) ?? Promise.resolve();
  const pending = waitForBundleLockTurn(previous, options.lockfilePath, name, enqueuedAt).then(
    execute,
  );
  // Completion only: a tail keeps no result alive once its own work has settled.
  const tail = Promise.allSettled([previous, pending]).then(() => undefined);
  bundleLockQueues.set(options.lockfilePath, tail);
  void tail.then(() => {
    if (bundleLockQueues.get(options.lockfilePath) === tail)
      bundleLockQueues.delete(options.lockfilePath);
  });
  return pending;
}

function bundleLockOptions(store: RunBundleStore, name: string) {
  return { lockfilePath: path.join(store.runsDir, name), realpath: false, stale: 30_000 };
}

interface RunBundleMigration {
  version: 1;
  phase: 'copying' | 'verified' | 'complete';
  home: string;
  backupRoot: string;
  store: RunBundleStore;
  verifiedBundles: number;
  settings?: Record<string, unknown>;
}

export interface RunBundleMigrationResult {
  store: RunBundleStore;
  backupRoot: string;
  verifiedBundles: number;
}

export interface RunBundleMigrationRequest {
  home: string;
  runsDir: string;
  targetRoot: string;
  assertWriteRoom(root: string, copyBytes: number): Promise<void>;
}

function migrationFile(runsDir: string): string {
  return path.join(runsDir, 'bundle-store-migration.json');
}

async function readMigration(runsDir: string): Promise<RunBundleMigration | undefined> {
  const raw = await readOptional(migrationFile(runsDir));
  if (!raw) return undefined;
  const journal: RunBundleMigration = JSON.parse(raw);
  if (journal.version !== 1 || journal.store.runsDir !== runsDir || !path.isAbsolute(journal.home))
    throw new Error('Invalid run bundle migration journal.');
  return journal;
}

async function finishRunBundleMigration(journal: RunBundleMigration): Promise<void> {
  if (!journal.settings) throw new Error('Verified run bundle migration has no settings.');
  const owner = await readFile(path.join(journal.store.root, 'store.json'), 'utf8');
  if (JSON.stringify(JSON.parse(owner)) !== JSON.stringify(journal.store))
    throw new Error('Migrated run bundle store pairing changed.');
  // Two files cannot share a rename. The flushed journal is the commit point: every opener
  // rolls a verified transaction forward under the same lock before reading either file.
  await atomicJson(path.join(journal.home, 'run-bundle-retention.json'), journal.settings);
  await atomicJson(path.join(journal.store.runsDir, 'bundle-store.json'), journal.store);
  await atomicJson(migrationFile(journal.store.runsDir), { ...journal, phase: 'complete' });
}

async function recoverRunBundleMigration(runsDir: string): Promise<void> {
  const journal = await readMigration(runsDir);
  if (journal?.phase !== 'verified') return;
  await withBundleLock(
    journal.store,
    STORE_LOCK,
    { label: 'bundle migration recovery' },
    async () => {
      const current = await readMigration(runsDir);
      if (current?.phase === 'verified') await finishRunBundleMigration(current);
    },
    false,
  );
}

/** Retry partial copies, reusing identical files and removing only obsolete migration output. */
async function copyStoreTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  if ((await realpath(target)) !== target)
    throw new Error(`Run bundle migration target is redirected: ${target}`);
  const entries = await readdir(source, { withFileTypes: true });
  // Retention finishes these moves outside the store lock. Leave the backup untouched by
  // waiting for that work to finish before taking a snapshot of the remaining store.
  if (entries.some(({ name }) => name.startsWith('.retention-')))
    throw new Error('Run bundle archive is staged; finish retention before retrying migration.');
  const names = new Set(entries.map(({ name }) => name));
  for (const name of await readdir(target))
    if (!names.has(name)) await rm(path.join(target, name), { recursive: true, force: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink() || (await realpath(from)) !== from)
      throw new Error(`Run bundle migration refuses redirected paths: ${from}`);
    let existing: Stats | undefined;
    try {
      existing = await lstat(to);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    if (existing?.isSymbolicLink())
      throw new Error(`Run bundle migration target is redirected: ${to}`);
    if (entry.isDirectory()) {
      if (existing && !existing.isDirectory())
        throw new Error(`Run bundle migration target differs: ${to}`);
      await copyStoreTree(from, to);
    } else if (entry.isFile()) {
      const bytes = (await stat(from)).size;
      const original = await copyHashed(from, null, bytes);
      if (
        existing?.isFile() &&
        existing.size === bytes &&
        (await copyHashed(to, null, bytes)).sha256 === original.sha256
      )
        continue;
      const partial = `${to}.${randomUUID()}.tmp`;
      await copyFile(from, partial, constants.COPYFILE_FICLONE);
      await syncPath(partial);
      const copied = await copyHashed(partial, null, bytes);
      if (copied.bytes !== bytes || copied.sha256 !== original.sha256)
        throw new Error(`Run bundle migration copy verification failed: ${from}`);
      await rename(partial, to);
    } else throw new Error(`Unsupported run bundle store entry: ${from}`);
  }
  await syncPath(target);
}

async function verifyMigratedBundles(store: RunBundleStore): Promise<number> {
  let count = 0;
  const digests = await readdir(path.join(store.root, 'sha256')).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  });
  for (const digest of digests) {
    if (!BUNDLE_DIGEST.test(digest)) continue;
    const { directory, manifest } = await readRetainedManifest(store, digest);
    const raw = await readOptional(path.join(store.root, 'availability', `${digest}.json`));
    const availability: RunBundleAvailability = raw
      ? JSON.parse(raw)
      : { revision: 0, prunedPaths: [] };
    for (const [key, meta] of Object.entries(manifest.entries)) {
      let file = resolvePathInsideRoot(directory, key);
      if (!existsSync(file)) {
        const archived = availability.archivedPaths?.[key];
        if (archived) file = archived;
        else if (
          availability.prunedPaths.includes(key) ||
          manifest.missingData?.some((value) =>
            key.endsWith(`/${parseRunBundleMissingData(value).path}`),
          )
        )
          continue;
        else throw new Error(`Run bundle migration verification missing entry: ${key}`);
      }
      if ((await realpath(file)) !== file || !(await lstat(file)).isFile())
        throw new Error(`Run bundle migration verification redirected entry: ${key}`);
      const actual = await copyHashed(file, null, meta.bytes);
      if (actual.bytes !== meta.bytes || actual.sha256 !== meta.sha256)
        throw new Error(`Run bundle migration entry verification failed: ${key}`);
    }
    const recorded = await readBundleRecord(store, digest);
    if (
      (recorded === undefined && existsSync(bundleUsagePath(store, digest))) ||
      (recorded !== undefined && recorded !== (await physicalBytes(directory)))
    )
      throw new Error(`Run bundle migration recorded bytes differ: ${digest}`);
    count++;
  }
  return count;
}

/** Offline operator command and gateway writes share the Run store's cross-process lock. */
export async function migrateRunBundleStore(
  input: RunBundleMigrationRequest,
): Promise<RunBundleMigrationResult> {
  const source = await openRunBundleStore(input);
  const requested = absoluteStoreRoot(input.targetRoot);
  await assertStoreRootParent(requested);
  const targetRoot = await realpath(requested).catch(async (error: unknown) => {
    if (!hasCode(error, 'ENOENT')) throw error;
    return path.join(await realpath(path.dirname(requested)), path.basename(requested));
  });
  return withRunBundleStoreLock(
    source,
    async () => {
      let journal = await readMigration(source.runsDir);
      if (source.root === targetRoot) {
        if (journal?.phase !== 'complete' || journal.store.root !== targetRoot)
          throw new Error('Run bundle store already uses the target without a migration backup.');
        return {
          store: journal.store,
          backupRoot: journal.backupRoot,
          verifiedBundles: journal.verifiedBundles,
        };
      }
      if (
        targetRoot.startsWith(source.root + path.sep) ||
        source.root.startsWith(targetRoot + path.sep)
      )
        throw new Error('Run bundle migration roots must not overlap.');
      const resuming =
        journal?.phase === 'copying' &&
        journal.store.root === targetRoot &&
        journal.backupRoot === source.root &&
        journal.home === path.resolve(input.home);
      if (journal?.phase === 'copying' && !resuming)
        throw new Error('A different run bundle migration is incomplete; resume its target first.');
      if (!resuming && existsSync(targetRoot) && (await readdir(targetRoot)).length)
        throw new Error('Run bundle migration target must be empty; unrelated data retained.');
      // Repairs transfer into staging outside the global lock. Do not snapshot a live transfer.
      for (const name of await readdir(source.runsDir)) {
        if (!/^bundle-repair-[a-f0-9]{64}\.lock$/u.test(name)) continue;
        const options = bundleLockOptions(source, name);
        if (await lockfile.check(options.lockfilePath, options))
          throw new Error(
            'Run bundle media transfer is active; retry migration after capture finishes.',
          );
      }
      // Charge the whole copy conservatively even on retries or clone-capable filesystems.
      await input.assertWriteRoom(targetRoot, await physicalBytes(source.root));
      journal = {
        version: 1,
        phase: 'copying',
        home: path.resolve(input.home),
        backupRoot: source.root,
        store: { ...source, root: targetRoot },
        verifiedBundles: 0,
      };
      await atomicJson(migrationFile(source.runsDir), journal);
      await copyStoreTree(source.root, targetRoot);
      journal.verifiedBundles = await verifyMigratedBundles(journal.store);
      const settings = retentionDocument(input.home);
      const retention = settings.runBundleRetention;
      if (!isRecord(retention)) throw new Error('Invalid runBundleRetention settings.');
      journal.settings = {
        ...settings,
        runBundleRetention: { ...retention, storeRoot: targetRoot },
      };
      await atomicJson(path.join(targetRoot, 'store.json'), journal.store);
      await syncPath(path.dirname(targetRoot));
      journal.phase = 'verified';
      await atomicJson(migrationFile(source.runsDir), journal);
      await finishRunBundleMigration(journal);
      return {
        store: journal.store,
        backupRoot: journal.backupRoot,
        verifiedBundles: journal.verifiedBundles,
      };
    },
    { label: 'run bundle store migration', holdLimitMs: 24 * 60 * 60_000 },
  );
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

/** Lets a walk charge a dir from a kept size instead of entering it, and keep what it walked. */
interface WalkHooks {
  kept(directory: string, depth: number): number | undefined;
  walked(directory: string, depth: number, bytes: number): void;
}

async function physicalBytes(
  root: string,
  scan?: AcquisitionScan,
  hooks?: WalkHooks,
): Promise<number> {
  const limit = concurrencyLimit(PHYSICAL_SCAN_CONCURRENCY);
  const walk = async (directory: string, depth = 0): Promise<number> => {
    const kept = hooks?.kept(directory, depth);
    if (kept !== undefined) return kept;
    const bytes = await walkEntries(directory, depth);
    hooks?.walked(directory, depth, bytes);
    return bytes;
  };
  const walkEntries = async (directory: string, depth: number): Promise<number> => {
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
        if (entry.isDirectory()) return walk(file, depth + 1);
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
  if (!manifest) return physicalBytes(directory);
  const digest = sha256Text(manifest);
  const recorded = await readBundleRecord(store, digest);
  if (recorded !== undefined) return recorded;
  // Moved aside before it had a record (published before records existed): measured once.
  const measured = await physicalBytes(directory);
  await recordBundleBytes(store, digest, measured);
  return measured;
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
    // Records (and the kept acquisition footprints) are bookkeeping, not stored payload.
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

/** What a settled scan reads and keeps: one footprint per settled task dir, by its token. */
interface KeptFootprint {
  token: string;
  bytes: number;
  /** Measured since the file was last written. */
  unsaved?: true;
}

interface SettledTaskDirs {
  store: RunBundleStore;
  token: AcquisitionTaskDirToken;
  footprints: Map<string, KeptFootprint>;
  seen: Set<string>;
}

const keptFootprints = new Map<string, Promise<Map<string, KeptFootprint>>>();

// Under usage/, which capacity accounting skips, so neither the file nor its temporary is charged.
function footprintFile(store: RunBundleStore): string {
  return path.join(store.root, 'usage', 'acquisition-footprints.json');
}

/** Loaded once per process; a corrupt file only costs one walk of each settled dir. */
function loadKeptFootprints(store: RunBundleStore) {
  let kept = keptFootprints.get(store.root);
  if (!kept) {
    kept = (async () => {
      const footprints = new Map<string, KeptFootprint>();
      try {
        const parsed: unknown = JSON.parse((await readOptional(footprintFile(store))) ?? '{}');
        const dirs = (parsed as { v?: unknown; dirs?: unknown }).dirs;
        if ((parsed as { v?: unknown }).v === 1 && dirs && typeof dirs === 'object')
          for (const [directory, entry] of Object.entries(dirs)) {
            const { token, bytes } = (entry ?? {}) as { token?: unknown; bytes?: unknown };
            if (typeof token === 'string' && Number.isSafeInteger(bytes) && (bytes as number) >= 0)
              footprints.set(directory, { token, bytes: bytes as number });
          }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      return footprints;
    })();
    // A failed read (EMFILE, EIO) is retried by the next scan, not kept for the process.
    kept.catch(() => keptFootprints.delete(store.root));
    keptFootprints.set(store.root, kept);
  }
  return kept;
}

const footprintSaves = new Map<string, Promise<void>>();

/**
 * One save at a time per store, each writing the map as it is when its turn comes, so an
 * earlier snapshot can never land over a later forget. Only the entries it wrote are clean.
 */
function saveKeptFootprints(
  store: RunBundleStore,
  footprints: Map<string, KeptFootprint>,
): Promise<void> {
  const save = (footprintSaves.get(store.root) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const saved = [...footprints];
      const dirs = Object.fromEntries(
        saved.map(([directory, { token, bytes }]) => [directory, { token, bytes }]),
      );
      await atomicJson(footprintFile(store), { v: 1, dirs });
      for (const [, kept] of saved) delete kept.unsaved;
    });
  footprintSaves.set(store.root, save);
  return save;
}

/**
 * Drops the kept footprints of task dirs the gateway is about to write outside its runs' own
 * updates, durably, so neither a crash mid-write nor a restart can bring a stale one back. If
 * the file cannot be rewritten it is removed, and every settled dir is walked once more; only
 * when that fails too does the forget fail.
 */
export async function forgetAcquisitionFootprints(
  store: RunBundleStore,
  directories: readonly string[],
): Promise<void> {
  try {
    const footprints = await loadKeptFootprints(store);
    let changed = false;
    for (const directory of directories) changed = footprints.delete(directory) || changed;
    if (changed) await saveKeptFootprints(store, footprints);
  } catch {
    await rm(footprintFile(store), { force: true });
  }
}

/**
 * Share only an in-flight scan. Live task dirs are walked on every read; with a classifier,
 * a settled one is charged the footprint kept for its token.
 */
async function acquisitionBytes(
  root: string,
  settled?: { store: RunBundleStore; classify: AcquisitionTaskDirClassifier },
): Promise<AcquisitionScan> {
  let scan = acquisitionScans.get(root);
  if (!scan) {
    scan = scanAcquisitionBytes(root, settled).finally(() => acquisitionScans.delete(root));
    acquisitionScans.set(root, scan);
  }
  return scan;
}

/** Count every gateway acquisition tree, including preserved media of archived/deleted runs. */
async function scanAcquisitionBytes(
  root: string,
  settledBy?: { store: RunBundleStore; classify: AcquisitionTaskDirClassifier },
): Promise<AcquisitionScan> {
  const started = performance.now();
  const scan: AcquisitionScan = { bytes: 0, fileCount: 0, settledDirs: 0, durationMs: 0 };
  const settled: SettledTaskDirs | undefined = settledBy && {
    store: settledBy.store,
    token: await settledBy.classify(),
    footprints: await loadKeptFootprints(settledBy.store),
    seen: new Set(),
  };
  let bytes = 0;
  const layout = { farmslotRoot: root, projectsDir: resolveProjectsDir(root) };
  // A projects dir inside .sandbox (desktop validation) is charged once, not again below.
  const counted = new Set<string>();
  for (const { root: taskRoot } of await listProjectTaskRoots(layout)) {
    counted.add(path.resolve(taskRoot));
    bytes += await taskRootBytes(taskRoot, scan, settled);
  }
  const sandbox = async (directory: string): Promise<number> => {
    if (path.basename(directory) === ORCHESTRATOR_TASK_DIR)
      return counted.has(path.resolve(directory)) ? 0 : taskRootBytes(directory, scan, settled);
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
  if (settled) {
    // A dir that went live, moved or was removed drops its footprint.
    let changed = false;
    for (const [directory, kept] of settled.footprints) {
      if (settled.seen.has(directory)) changed ||= kept.unsaved === true;
      else {
        settled.footprints.delete(directory);
        changed = true;
      }
    }
    if (changed) await saveKeptFootprints(settled.store, settled.footprints);
  }
  scan.durationMs = performance.now() - started;
  return scan;
}

/**
 * A task root holds `<flow>/<task>` dirs. A settled task dir is charged the footprint kept for
 * its token; a missing or stale one is walked and kept. Live dirs are walked as before.
 */
function taskRootBytes(
  taskRoot: string,
  scan: AcquisitionScan,
  settled?: SettledTaskDirs,
): Promise<number> {
  const TASK_DEPTH = 2;
  const walking = new Map<string, string>();
  return physicalBytes(
    taskRoot,
    scan,
    settled && {
      kept: (directory, depth) => {
        if (depth !== TASK_DEPTH) return undefined;
        const token = settled.token(directory);
        if (token === undefined) return undefined;
        settled.seen.add(directory);
        const kept = settled.footprints.get(directory);
        if (kept?.token === token) {
          scan.settledDirs++;
          return kept.bytes;
        }
        walking.set(directory, token);
        return undefined;
      },
      walked: (directory, depth, bytes) => {
        const token = depth === TASK_DEPTH ? walking.get(directory) : undefined;
        walking.delete(directory);
        // A token that changed during the walk (a write began, even one already over) keeps nothing.
        if (token !== undefined && settled.token(directory) === token)
          settled.footprints.set(directory, { token, bytes, unsaved: true });
      },
    },
  );
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
export interface RunBundleAdmissionUsage {
  store: number;
  reservations: number;
  /** Gateway task trees; archival of bundles cannot free these. */
  acquisition: number;
  total: number;
}

/** What capture admission charges against `maxStoreBytes`, split by what holds it. */
export async function runBundleAdmissionUsage(
  store: RunBundleStore,
  farmslotRoot: string,
  taskDirs?: AcquisitionTaskDirClassifier,
): Promise<RunBundleAdmissionUsage> {
  // Store accounting can record a legacy bundle's bytes, which only ever happens under the lock.
  const { stored, reservations } = await withRunBundleStoreLock(store, async () => ({
    stored: await chargedStoreBytes(store),
    reservations: await reservedMetadataBytes(store),
  }));
  const acquisition = (
    await acquisitionBytes(farmslotRoot, taskDirs && { store, classify: taskDirs })
  ).bytes;
  return { store: stored, reservations, acquisition, total: stored + reservations + acquisition };
}

/** Admission refused for capacity, which housekeeping may free; other refusals it cannot. */
export class RunBundleCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunBundleCapacityError';
  }
}

export async function reserveRunBundleMetadata(
  store: RunBundleStore,
  runId: string,
  policy = DEFAULT_RUN_BUNDLE_RETENTION,
  farmslotRoot?: string,
  taskDirs?: AcquisitionTaskDirClassifier,
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
        acquisitionBytes(farmslotRoot, taskDirs && { store, classify: taskDirs }).then(
          (scan) => scan.bytes,
        ),
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
  return withBundleLock(store, STORE_LOCK, { label: `admission of run ${runId}` }, async () => {
    if (await readOptional(file)) return;
    const bytes = Math.min(1024 ** 2, policy.metadataReserveBytes);
    const reserved = await reservedMetadataBytes(store);
    if (
      bytes === 0 ||
      reserved + bytes > policy.metadataReserveBytes ||
      (await chargedStoreBytes(store)) + reserved + bytes + acquisitionSize > policy.maxStoreBytes
    )
      throw new RunBundleCapacityError(
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
  prefix = false,
): Promise<RunBundlePayloadIdentity> {
  if (dest) await mkdir(path.dirname(dest), { recursive: true });
  const digest = createHash('sha256');
  let bytes = 0;
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await pipeline(
      handle.createReadStream(prefix ? { end: maxBytes - 1 } : undefined),
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
  if (prefix && bytes !== maxBytes) throw new Error('Decision history prefix is incomplete.');
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
    storeRoot: store.root,
  });
  if (binding.id !== store.id || binding.root !== store.root)
    throw new Error('Run bundle store pairing changed.');
}

const manifestCache = new Map<string, RunBundleManifest>();

const payloadKey = (meta: { sha256: string; bytes: number }) => `${meta.sha256}:${meta.bytes}`;

/**
 * Payloads the run's other bundles already hold, by content. A recapture's media is
 * usually byte-identical to the previous capture's, so it is cloned from the store
 * instead of fetched from the slot again. Read from manifests; no directory walk.
 */
async function retainedPayloadsByContent(
  store: RunBundleStore,
  run: Run,
  exceptDigest: string,
): Promise<Map<string, string[]>> {
  const payloads = new Map<string, string[]>();
  const digests = new Set<string>();
  for (const { ref } of runBundleRefs(run)) {
    const { storeId, bundleDigest } = resolveRetainedRunBundleRef(run, ref);
    if (storeId === store.id && bundleDigest !== exceptDigest) digests.add(bundleDigest);
  }
  for (const digest of digests) {
    let retained: Awaited<ReturnType<typeof readRetainedManifest>>;
    try {
      retained = await readRetainedManifest(store, digest);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue; // archived: the slot copy remains the source
      throw error;
    }
    const { directory, manifest } = retained;
    const availabilityRaw = await readOptional(
      path.join(store.root, 'availability', `${digest}.json`),
    );
    const availability: RunBundleAvailability | undefined = availabilityRaw
      ? JSON.parse(availabilityRaw)
      : undefined;
    // A deferred payload may be listed without being stored (or stored by a later repair):
    // every listed entry is a candidate, and cloning skips one that isn't on disk.
    for (const [key, meta] of Object.entries(manifest.entries)) {
      const candidates = payloads.get(payloadKey(meta)) ?? [];
      candidates.push(resolvePathInsideRoot(directory, key));
      if (availability?.archivedPaths?.[key]) candidates.push(availability.archivedPaths[key]);
      payloads.set(payloadKey(meta), candidates);
    }
  }
  return payloads;
}

/** Clones the first candidate still on disk (copy-on-write where the volume allows it). */
async function cloneRetainedPayload(
  candidates: string[],
  destination: string,
  maxBytes: number,
): Promise<RunBundlePayloadIdentity | undefined> {
  for (const source of candidates) {
    try {
      // Not on disk (deferred, or archived since the lookup), or not the size it claims.
      if ((await stat(source)).size !== maxBytes) continue;
      await copyFile(source, destination, constants.COPYFILE_FICLONE);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue;
      throw error;
    }
    return copyHashed(destination, null, maxBytes);
  }
  return undefined;
}

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
  const availability = await readRunBundleAvailability(request.store, ref, request.run.id);
  try {
    const pending: Array<[string, RunBundleManifest['entries'][string]]> = [];
    const localKeys = new Set<string>();
    for (const [key, meta] of Object.entries(manifest.entries)) {
      if (!key.startsWith(prefix)) continue;
      const target = resolvePathInsideRoot(directory, key);
      try {
        await stat(target);
        localKeys.add(key);
        continue;
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      if (availability.archivedPaths?.[key]) {
        // Replaying a capture uses its verified archive instead of downloading it again.
        const retained = await readRetainedRunBundle(request.store, ref, request.run.id);
        await retained.resolveEntry(key.slice(prefix.length));
        continue;
      }
      pending.push([key, meta]);
    }
    let remaining = 0;
    const admission = { label: `media admission of run ${request.run.id}` };
    const admitted = await withBundleLock(request.store, STORE_LOCK, admission, async () => {
      const selected: typeof pending = [];
      if (!pending.length) return selected;
      // The presence check above already says which manifest entries are on disk, so the
      // bundle's bytes follow from the manifest; this also corrects a record a crash left stale.
      let present = (await stat(path.join(directory, 'manifest.json'))).size;
      for (const [key, meta] of Object.entries(manifest.entries))
        if (!key.startsWith(prefix) || localKeys.has(key)) present += meta.bytes;
      await recordBundleBytes(request.store, ref.bundleDigest, present);
      await archiveCaptureMedia(
        request,
        acquisitionSize,
        pending.reduce((bytes, [, meta]) => bytes + meta.bytes, 0) + policy.metadataReserveBytes,
      );
      let storeAvailable =
        policy.maxStoreBytes - (await chargedCaptureBytes(request, acquisitionSize));
      let bundleAvailable = policy.maxBundleBytes - present;
      for (const [key, meta] of pending) {
        const relative = key.slice(prefix.length);
        const reserve = isRunBundleMedia(relative) ? policy.metadataReserveBytes : 0;
        if (meta.bytes > Math.min(storeAvailable - reserve, bundleAvailable)) {
          if (request.archiveRoot)
            throw new RunBundleCapacityError(
              `Cannot retain media-capacity:${relative}; pinned media or metadata still occupies capacity. Source retained; retry after freeing capacity.`,
            );
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
    const retainedElsewhere = admitted.length
      ? await retainedPayloadsByContent(request.store, request.run, ref.bundleDigest)
      : new Map<string, string[]>();
    for (const [key, meta] of admitted) {
      const relative = key.slice(prefix.length);
      const target = resolvePathInsideRoot(directory, key);
      const temp = path.join(repairStage, `${randomUUID()}.tmp`);
      try {
        let copied: RunBundlePayloadIdentity;
        const retained = isRunBundleMedia(relative)
          ? retainedElsewhere.get(payloadKey(meta))
          : undefined;
        // Verified against the manifest below like any other source.
        const fromStore = retained && (await cloneRetainedPayload(retained, temp, meta.bytes));
        if (fromStore) copied = fromStore;
        else if (request.acquireMedia && isRunBundleMedia(relative)) {
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
        if (hasCode(error, 'ENOENT')) missing.push(`missing:${relative}`);
        // A source that grew past its captured size has changed since capture.
        else if (hasCode(error, 'EFBIG')) missing.push(`changed:${relative}`);
        else throw error;
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
        ...availability,
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
  manifest: RunBundleManifest,
): Promise<string[]> {
  const retained = await readRetainedRunBundle(request.store, ref, request.run.id);
  const availability = await readRunBundleAvailability(request.store, ref, request.run.id);
  const prefix = `tasks/${ref.taskKey}/`;
  const unavailable = [...(manifest.missingData ?? [])];
  for (const key of Object.keys(manifest.entries)) {
    if (!key.startsWith(prefix)) continue;
    try {
      await stat(
        availability.archivedPaths?.[key] ?? resolvePathInsideRoot(retained.directory, key),
      );
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

/**
 * A published bundle's manifest, digest-checked on every read; parsed metadata is cached.
 * Rejects with `ENOENT` once the bundle has left the store.
 */
async function readRetainedManifest(
  store: RunBundleStore,
  digest: string,
): Promise<{ directory: string; manifest: RunBundleManifest }> {
  const directory = bundleDirectory(store, digest);
  const cacheKey = `${store.id}:${digest}`;
  // Parsed metadata may be cached; the published manifest must still exist and match.
  const raw = await readFile(path.join(directory, 'manifest.json'), 'utf8');
  if (sha256Text(raw) !== digest) throw new Error('Retained bundle manifest digest mismatch.');
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
  return { directory, manifest };
}

export async function readRetainedRunBundle(
  store: RunBundleStore,
  ref: RunArtifactBundleRef,
  runId: string,
): Promise<RetainedRunBundleSnapshot> {
  await assertStorePairing(store);
  if (store.id !== ref.storeId) throw new Error('Retained bundle belongs to another Run store.');
  assertSafeBundleSegment(ref.taskKey, 'task key');
  const { directory, manifest } = await readRetainedManifest(store, ref.bundleDigest);
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
    let file = resolvePathInsideRoot(directory, key);
    let archivePath: string | undefined;
    let real: string;
    try {
      real = await realpath(file);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      const raw = await readOptional(
        path.join(store.root, 'availability', `${ref.bundleDigest}.json`),
      );
      const availability: RunBundleAvailability | undefined = raw ? JSON.parse(raw) : undefined;
      archivePath = availability?.archivedPaths?.[key];
      if (archivePath) {
        if (!path.isAbsolute(archivePath) || !isRunBundleMedia(key))
          throw new Error('Invalid retained media archive path.');
        file = archivePath;
        real = await realpath(file);
      } else {
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
    }
    if (real !== file) throw new Error('Retained bundle contains a redirected path.');
    const info = await lstat(file);
    if (!info.isFile() || info.size !== meta.bytes)
      throw new Error(`Retained artifact is missing, pruned or changed: ${relativePath}`);
    if (archivePath && (await copyHashed(file, null, meta.bytes)).sha256 !== meta.sha256)
      throw new Error(`Retained archive bytes changed: ${relativePath}`);
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
  store: 'bundle-reservations' | 'bundle-intents' | 'bundle-staging' | 'run-bundles';
}

/** Metadata/staging selection shared by the standalone collector and archive-only gateway. Caller holds the bundle lock. */
async function runBundleHousekeepingInventory(store: RunBundleStore, now: number) {
  const cleanup: RunBundleHousekeepingPath[] = [];
  const referenced = new Set<string>();
  const activeRuns = new Map<string, number | undefined>();
  const pinned = new Set<string>();
  const retainReference = (ref: RunArtifactBundleRef | undefined, pin: boolean) => {
    if (!ref || ref.storeId !== store.id) return;
    referenced.add(ref.bundleDigest);
    if (pin) pinned.add(ref.bundleDigest);
  };
  for (const runsDir of [store.runsDir, path.join(store.runsDir, 'archive')]) {
    for (const run of loadAllRunRecords(runsDir)) {
      const retain = (ref: RunArtifactBundleRef | undefined, pin: boolean) =>
        retainReference(ref ? resolveRetainedRunBundleRef(run, ref) : undefined, pin);
      const active = isActiveListRun(run);
      if (active) activeRuns.set(run.id, run.engineState?.generation);
      for (const { ref, decision } of runBundleRefs(run))
        retain(
          ref,
          active ||
            (decision
              ? !decision.resolvedAt ||
                (decision.payload?.kind === 'ready' &&
                  ['published_draft', 'published_ready'].includes(
                    decision.payload.prPackage?.publicationStatus ?? '',
                  ))
              : false),
        );
      // Retired approvals/attestations remain audit dependencies after replay removes the card.
      for (const decision of readDecisionHistoryFile(
        decisionHistoryFile(path.join(runsDir, `${run.id}.json`)),
      )) {
        if (decision.publicationApproval || decision.evidenceAttestation)
          retain(decisionArtifactBundleRef(run, decision.payload), true);
      }
    }
  }
  const intentsDir = path.join(store.runsDir, 'bundle-intents');
  await mkdir(intentsDir, { recursive: true });
  const activeStages = new Set<string>();
  const captureRuns = new Set<string>();
  const committedIntents = new Map<string, string[]>();
  const newestCommitted = new Map<string, CaptureIntent>();
  for (const file of await readdir(intentsDir)) {
    if (!file.endsWith('.json')) continue;
    const intentPath = path.join(intentsDir, file);
    const intent: CaptureIntent = JSON.parse(await readFile(intentPath, 'utf8'));
    // A prepared package can outlive the current output pointer before its gate is recorded.
    // Only the run's current generation, or its newest capture, can still be that package.
    if (intent.committed && intent.bundleDigest && activeRuns.has(intent.runId)) {
      const newest = newestCommitted.get(intent.runId);
      if (!newest || intent.exportedAt > newest.exportedAt)
        newestCommitted.set(intent.runId, intent);
      if (intent.generation === activeRuns.get(intent.runId)) pinned.add(intent.bundleDigest);
    }
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
  for (const intent of newestCommitted.values()) pinned.add(intent.bundleDigest!);
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
  // A bundle no run references and no live capture pins is superseded storage: archive it,
  // with its retry intents, so a later capture with the same key starts over.
  const archivable: RunBundleHousekeepingPath[] = [];
  const digestRoot = path.join(store.root, 'sha256');
  await mkdir(digestRoot, { recursive: true });
  for (const digest of await readdir(digestRoot)) {
    // Archive staging (`.retention-*`) and other non-bundle names are not this selection's.
    if (!/^[a-f0-9]{64}$/u.test(digest)) continue;
    if (referenced.has(digest) || pinned.has(digest)) continue;
    const directory = bundleDirectory(store, digest);
    let runId = 'bundle-housekeeping';
    try {
      runId = parseManifest(directory).runs[0]?.originalRunId ?? runId;
    } catch {
      // An unreadable manifest is still unreferenced storage.
    }
    // Intents first: a host interrupted between entries leaves the bundle to select again.
    for (const intent of committedIntents.get(digest) ?? [])
      archivable.push({ path: intent, runId, store: 'bundle-intents' });
    archivable.push({ path: directory, runId, store: 'run-bundles' });
  }
  return { cleanup, archivable, referenced, pinned, committedIntents };
}

/** Store lock held throughout selection, verified copy, location journal and source removal. */
async function archiveRunBundleMediaLocked(
  input: RunBundleMediaArchiveRequest,
  acquisitionSize: number,
  requiredBytes = 0,
  capturing?: MaterializeRunBundleRequest,
): Promise<RunBundleMediaArchiveResult> {
  const { store } = input;
  let archiveRoot = input.archiveRoot;
  const policy = input.policy ?? DEFAULT_RUN_BUNDLE_RETENTION;
  const now = input.now ?? Date.now();
  const charged = async () =>
    (await chargedStoreBytes(store)) + (await reservedMetadataBytes(store)) + acquisitionSize;
  const chargedBytesBefore = await charged();
  const pressure =
    chargedBytesBefore >= policy.maxStoreBytes * RUN_BUNDLE_ARCHIVE_HIGH_RATIO ||
    chargedBytesBefore + requiredBytes > policy.maxStoreBytes;
  const result: RunBundleMediaArchiveResult = {
    reclaimedBytes: 0,
    archivedPaths: [],
    pressure,
    chargedBytesBefore,
    chargedBytesAfter: chargedBytesBefore,
  };
  if (capturing && !pressure) return result;
  const { pinned, referenced } = await runBundleHousekeepingInventory(store, now);
  const candidates = [];
  for (const digest of await readdir(path.join(store.root, 'sha256'))) {
    if (!BUNDLE_DIGEST.test(digest) || pinned.has(digest) || !referenced.has(digest)) continue;
    const { directory, manifest } = await readRetainedManifest(store, digest);
    if (
      capturing &&
      (manifest.runs.some(({ originalRunId }) => originalRunId === capturing.run.id) ||
        capturing.taskDir.startsWith(directory + path.sep))
    )
      continue;
    candidates.push({ digest, directory, manifest });
  }
  candidates.sort(
    (a, b) =>
      Date.parse(a.manifest.exportedAt) - Date.parse(b.manifest.exportedAt) ||
      a.digest.localeCompare(b.digest),
  );
  let checkedRoot = false;
  for (const { digest, directory, manifest } of candidates) {
    const expired = now - Date.parse(manifest.exportedAt) >= policy.mediaRetentionDays * 86_400_000;
    const availabilityFile = path.join(store.root, 'availability', `${digest}.json`);
    const raw = await readOptional(availabilityFile);
    const availability: RunBundleAvailability = raw
      ? JSON.parse(raw)
      : { revision: 0, prunedPaths: [] };
    // A crash after unlink but before accounting leaves an overcharge, never uncharged payload.
    if (availability.archivedPaths)
      await recordBundleBytes(store, digest, await physicalBytes(directory));
    for (const [key, meta] of Object.entries(manifest.entries)) {
      if (!isRunBundleMedia(key)) continue;
      if (
        !expired &&
        (!pressure ||
          (result.chargedBytesAfter <= policy.maxStoreBytes * RUN_BUNDLE_ARCHIVE_LOW_RATIO &&
            result.chargedBytesAfter + requiredBytes <= policy.maxStoreBytes))
      )
        break;
      const source = resolvePathInsideRoot(directory, key);
      try {
        if (!(await lstat(source)).isFile() || (await realpath(source)) !== source)
          throw new Error('Retained archive source is redirected.');
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue; // Already archived, or never retained.
        throw error;
      }
      if (!checkedRoot) {
        if (
          !path.isAbsolute(archiveRoot) ||
          !(await lstat(archiveRoot)).isDirectory() ||
          archiveRoot === store.root ||
          archiveRoot.startsWith(store.root + path.sep) ||
          store.root.startsWith(archiveRoot + path.sep)
        )
          throw new Error('Run media archive must be an existing, separate absolute directory.');
        archiveRoot = await realpath(archiveRoot);
        if (
          archiveRoot === store.root ||
          archiveRoot.startsWith(store.root + path.sep) ||
          store.root.startsWith(archiveRoot + path.sep)
        )
          throw new Error('Run media archive overlaps the bundle store.');
        checkedRoot = true;
      }
      // The bundle equivalent of storage-archive's staged cross-volume move: flush and verify
      // a partial copy, publish it, journal its location, then remove the original. Retries
      // reuse the deterministic destination, including after a crash before journaling it.
      const destination = path.join(
        archiveRoot,
        'run-bundle-media',
        store.id,
        digest,
        sha256Text(key),
      );
      const parent = path.dirname(destination);
      if (!(await readOptionalArchiveIdentity(destination, meta))) {
        await input.assertArchiveWriteRoom?.(archiveRoot, meta.bytes);
        await mkdir(parent, { recursive: true });
        if ((await realpath(parent)) !== parent)
          throw new Error('Run media archive is redirected.');
        const partial = `${destination}.copy`;
        await rm(partial, { force: true });
        // Hash the source during copy and again afterward to detect mutation; hash the copy to verify it.
        const copied = await copyHashed(source, partial, meta.bytes);
        const verified = await copyHashed(partial, null, meta.bytes);
        const unchanged = await copyHashed(source, null, meta.bytes);
        if (
          [copied, verified, unchanged].some(
            ({ sha256, bytes }) => sha256 !== meta.sha256 || bytes !== meta.bytes,
          )
        )
          throw new Error(`Run media archive verification failed; source retained: ${key}`);
        await rename(partial, destination);
      }
      for (let dir = parent; dir !== path.dirname(archiveRoot); dir = path.dirname(dir))
        await syncPath(dir);
      availability.archivedPaths = { ...availability.archivedPaths, [key]: destination };
      availability.prunedPaths = availability.prunedPaths.filter((file) => file !== key);
      availability.revision++;
      await atomicJson(availabilityFile, availability);
      await rm(source);
      await syncPath(path.dirname(source));
      await recordBundleBytes(store, digest, await physicalBytes(directory));
      result.reclaimedBytes += meta.bytes;
      result.archivedPaths.push(key);
      result.chargedBytesAfter = await charged();
    }
  }
  result.chargedBytesAfter = await charged();
  return result;
}

async function readOptionalArchiveIdentity(
  file: string,
  expected: RunBundlePayloadIdentity,
): Promise<boolean> {
  try {
    if ((await realpath(file)) !== file) throw new Error('Run media archive is redirected.');
    const actual = await copyHashed(file, null, expected.bytes);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new Error(`Run media archive differs; source retained: ${file}`);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function archiveRunBundleMedia(
  input: RunBundleMediaArchiveRequest,
): Promise<RunBundleMediaArchiveResult> {
  await assertStorePairing(input.store);
  assertPolicy(input.policy ?? DEFAULT_RUN_BUNDLE_RETENTION);
  const acquisition = await acquisitionBytes(
    input.farmslotRoot,
    input.acquisitionTaskDirs && { store: input.store, classify: input.acquisitionTaskDirs },
  );
  return withRunBundleStoreLock(
    input.store,
    () => archiveRunBundleMediaLocked(input, acquisition.bytes),
    { label: 'run media archival' },
  );
}

async function archiveCaptureMedia(
  request: MaterializeRunBundleRequest,
  acquisitionSize: number,
  requiredBytes = 0,
) {
  if (!request.archiveRoot) return;
  const result = await archiveRunBundleMediaLocked(
    {
      store: request.store,
      farmslotRoot: request.farmslotRoot,
      archiveRoot: request.archiveRoot,
      assertArchiveWriteRoom: request.assertArchiveWriteRoom,
      policy: request.policy,
    },
    acquisitionSize,
    requiredBytes,
    request,
  );
  if (result.archivedPaths.length) request.onMediaArchived?.(result);
}

/** Select inactive reservations, abandoned capture scaffolding and superseded bundles without removing bytes. */
export async function runBundleHousekeepingPaths(
  store: RunBundleStore,
  now = Date.now(),
): Promise<RunBundleHousekeepingPath[]> {
  await assertStorePairing(store);
  const { cleanup, archivable } = await runBundleHousekeepingInventory(store, now);
  return [...cleanup, ...archivable];
}

export async function collectRunBundleGarbage(
  store: RunBundleStore,
  policy = DEFAULT_RUN_BUNDLE_RETENTION,
  now = Date.now(),
  archive?: Pick<
    RunBundleMediaArchiveRequest,
    'archiveRoot' | 'farmslotRoot' | 'assertArchiveWriteRoom'
  >,
): Promise<{ reclaimedBytes: number; prunedPaths: string[] }> {
  await assertStorePairing(store);
  assertPolicy(policy);
  const acquisition = archive ? (await acquisitionBytes(archive.farmslotRoot)).bytes : 0;
  return withBundleLock(store, STORE_LOCK, { label: 'bundle garbage collection' }, async () => {
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
    }
    if (archive) {
      const moved = await archiveRunBundleMediaLocked(
        {
          store,
          archiveRoot: archive.archiveRoot,
          assertArchiveWriteRoom: archive.assertArchiveWriteRoom,
          farmslotRoot: archive.farmslotRoot,
          policy,
          now,
        },
        acquisition,
      );
      reclaimedBytes += moved.reclaimedBytes;
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
  const acquisitionScan = await acquisitionBytes(
    request.farmslotRoot,
    request.acquisitionTaskDirs && {
      store: request.store,
      classify: request.acquisitionTaskDirs,
    },
  );
  const acquisitionSize = acquisitionScan.bytes;
  const capture = { label: `capture of run ${run.id}` };
  const captured = await withBundleLock(store, STORE_LOCK, capture, async () => {
    await archiveCaptureMedia(request, acquisitionSize);
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
        ...(run.engineState?.generation !== undefined
          ? { generation: run.engineState.generation }
          : {}),
        bundleDigest: request.existingRef.bundleDigest,
      };
      await atomicJson(intentPath, original);
      prior = JSON.stringify(original);
    }
    const liveHistory = decisionHistoryFile(path.join(store.runsDir, `${run.id}.json`));
    const historyFile = existsSync(liveHistory)
      ? liveHistory
      : decisionHistoryFile(path.join(store.runsDir, 'archive', `${run.id}.json`));
    if (!prior && run.decisionHistoryCount && !existsSync(historyFile))
      throw new Error(`Decision history missing for run ${run.id}`);
    const historyPrefix =
      !prior && existsSync(historyFile) ? captureDecisionHistoryPrefix(historyFile) : undefined;
    const intent: CaptureIntent = prior
      ? JSON.parse(prior)
      : {
          runId: run.id,
          key: request.captureKey,
          bundleId: randomUUID(),
          exportedAt: new Date().toISOString(),
          runJson: `${JSON.stringify(
            {
              ...sanitizeRunForBundleExport(run, 'reference'),
              ...(historyPrefix
                ? { decisionHistoryCount: historyPrefix.toString('utf8').split('\n').length - 1 }
                : {}),
            },
            null,
            2,
          )}\n`,
          ...(historyPrefix ? { decisionHistoryBytes: historyPrefix.byteLength } : {}),
          ...(run.engineState?.generation !== undefined
            ? { generation: run.engineState.generation }
            : {}),
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
      const missingData = await commitRetainedPayloads(request, ref, retained.manifest);
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
    let bundleBytes = Buffer.byteLength(intent.runJson) + (intent.decisionHistoryBytes ?? 0);
    let stagedBytes = bundleBytes;
    let storeBytes =
      (await chargedCaptureBytes(request, acquisitionSize)) + (intent.decisionHistoryBytes ?? 0);
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
      if (intent.decisionHistoryBytes) {
        if (
          bundleBytes + manifestReserve > policy.maxBundleBytes ||
          storeBytes + manifestReserve > policy.maxStoreBytes
        )
          throw new Error('Run bundle decision history exceeds reserved capacity.');
        const key = decisionHistoryFile(runPath);
        const copied = await copyHashed(
          historyFile,
          path.join(stage, key),
          intent.decisionHistoryBytes,
          true,
        );
        manifest.entries[key] = { path: key, ...copied };
      }
      for (const artifact of ordered) {
        assertSafeBundleRelativePath(artifact.path);
        if (
          shouldSkipBundleFile(path.posix.basename(artifact.path)) ||
          path.posix
            .dirname(artifact.path)
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
        let available = Math.min(
          policy.maxBundleBytes - bundleBytes - manifestReserve,
          policy.maxStoreBytes -
            storeBytes -
            manifestReserve -
            (media ? policy.metadataReserveBytes : 0),
        );
        if (media && size > available && request.archiveRoot) {
          const before = await chargedCaptureBytes(request, acquisitionSize);
          await archiveCaptureMedia(
            request,
            acquisitionSize,
            storeBytes - before + size + manifestReserve + policy.metadataReserveBytes,
          );
          storeBytes += (await chargedCaptureBytes(request, acquisitionSize)) - before;
          available = Math.min(
            policy.maxBundleBytes - bundleBytes - manifestReserve,
            policy.maxStoreBytes - storeBytes - manifestReserve - policy.metadataReserveBytes,
          );
          if (size > available)
            throw new RunBundleCapacityError(
              `Cannot retain media-capacity:${artifact.path}; pinned media or metadata still occupies capacity. Source retained; retry after freeing capacity.`,
            );
        }
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
      const remaining = await commitRetainedPayloads(request, ref, manifest);
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
  const repair = { label: `repair of run ${run.id}`, holdLimitMs: REPAIR_LOCK_HOLD_LIMIT_MS };
  return withBundleLock(store, repairLockName(captured.ref.bundleDigest), repair, async () => {
    const missingData = await completeRetainedPayloads(
      request,
      captured.ref,
      bundleDirectory(store, captured.ref.bundleDigest),
      captured.manifest,
      acquisitionSize,
    );
    return withBundleLock(store, STORE_LOCK, { label: `commit of run ${run.id}` }, async () => {
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
