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
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import lockfile from 'proper-lockfile';

import {
  type ArtifactRef,
  type Run,
  RUN_BUNDLE_VERSION,
  type RunArtifactBundleRef,
  type RunBundleManifest,
  type RunBundleRetentionPolicy,
} from '@farmslot/protocol';
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

export interface MaterializeRunBundleRequest {
  store: RunBundleStore;
  farmslotRoot: string;
  run: Run;
  taskDir: string;
  artifacts: readonly ArtifactRef[];
  manifestDigest: string;
  /** Persisted identity of this acquisition, including task and generation. */
  captureKey: string;
  existingRef?: RunArtifactBundleRef;
  policy?: RunBundleRetentionPolicy;
  stagingBytes?: number;
  allowChanged?: boolean;
  /** Must fence and durably commit the Run reference before returning. */
  commit(ref: RunArtifactBundleRef, missingData: string[]): Promise<void>;
}

export interface MaterializedRunBundle {
  ref: RunArtifactBundleRef;
  manifest: RunBundleManifest;
  missingData: string[];
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

/** One cross-process lock covers capture reservations, commit and GC. */
export async function withRunBundleStoreLock<T>(
  store: RunBundleStore,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(store.runsDir, {
    lockfilePath: path.join(store.runsDir, 'bundle-store.lock'),
    realpath: false,
    stale: 30_000,
    update: 2_000,
    retries: { retries: 120, factor: 1, minTimeout: 20, maxTimeout: 50 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function isRunBundleMedia(file: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|m4v|mp3|m4a|wav)$/iu.test(file);
}

async function physicalBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) total += await physicalBytes(file);
    else if (entry.isFile()) total += (await stat(file)).size;
  }
  return total;
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

/** Reserve lightweight output capacity before starting work, under the capture/GC lock. */
export async function reserveRunBundleMetadata(
  store: RunBundleStore,
  runId: string,
  policy = DEFAULT_RUN_BUNDLE_RETENTION,
): Promise<void> {
  await assertStorePairing(store);
  assertSafeBundleSegment(runId, 'run id');
  assertPolicy(policy);
  return withRunBundleStoreLock(store, async () => {
    const file = path.join(store.root, 'reservations', `${runId}.json`);
    if (await readOptional(file)) return;
    const bytes = Math.min(1024 ** 2, policy.metadataReserveBytes);
    const reserved = await reservedMetadataBytes(store);
    if (
      bytes === 0 ||
      reserved + bytes > policy.metadataReserveBytes ||
      (await physicalBytes(store.root)) + reserved + bytes > policy.maxStoreBytes
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
  dest: string,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  await mkdir(path.dirname(dest), { recursive: true });
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
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
    );
  } finally {
    await handle.close();
  }
  await chmod(dest, 0o400);
  return { sha256: digest.digest('hex'), bytes };
}

function bundleDirectory(store: RunBundleStore, digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Invalid retained bundle digest.');
  return path.join(store.root, 'sha256', digest);
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
): Promise<string[]> {
  const policy = request.policy ?? DEFAULT_RUN_BUNDLE_RETENTION;
  let used = (await physicalBytes(request.store.root)) + (request.stagingBytes ?? 0);
  let bundleBytes = await physicalBytes(directory);
  const prefix = `tasks/${ref.taskKey}/`;
  const missing: string[] = (manifest.missingData ?? []).filter(
    (reason) => !reason.startsWith('media-capacity:') && !reason.startsWith('missing:'),
  );
  const restored = new Set<string>();
  for (const [key, meta] of Object.entries(manifest.entries)) {
    if (!key.startsWith(prefix)) continue;
    const target = resolvePathInsideRoot(directory, key);
    try {
      await stat(target);
      continue;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    const relative = key.slice(prefix.length);
    if (
      meta.bytes >
      Math.min(
        policy.maxStoreBytes - used - policy.metadataReserveBytes,
        policy.maxBundleBytes - bundleBytes,
      )
    ) {
      missing.push(`media-capacity:${relative}`);
      continue;
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const taskRoot = await realpath(request.taskDir);
      const source = resolvePathInsideRoot(taskRoot, relative);
      if ((await realpath(source)) !== source)
        throw new Error('Retained repair source is redirected.');
      const copied = await copyHashed(source, temp, meta.bytes);
      if (copied.sha256 !== meta.sha256 || copied.bytes !== meta.bytes) {
        missing.push(`changed:${relative}`);
        await rm(temp);
        continue;
      }
      await rename(temp, target);
      restored.add(key);
      used += copied.bytes;
      bundleBytes += copied.bytes;
    } catch (error) {
      await rm(temp, { force: true });
      if (!hasCode(error, 'ENOENT')) throw error;
      missing.push(`missing:${relative}`);
    }
  }
  const availabilityPath = path.join(
    request.store.root,
    'availability',
    `${ref.bundleDigest}.json`,
  );
  const prior = await readOptional(availabilityPath);
  if (prior && restored.size) {
    const availability: RunBundleAvailability = JSON.parse(prior);
    await atomicJson(availabilityPath, {
      revision: availability.revision + 1,
      prunedPaths: availability.prunedPaths.filter((key) => !restored.has(key)),
    });
  }
  return missing;
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
  let manifest = manifestCache.get(cacheKey);
  if (!manifest) {
    const raw = await readFile(path.join(directory, 'manifest.json'), 'utf8');
    if (sha256Text(raw) !== ref.bundleDigest)
      throw new Error('Retained bundle manifest digest mismatch.');
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
    if ((await realpath(file)) !== file)
      throw new Error('Retained bundle contains a redirected path.');
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
export async function collectRunBundleGarbage(
  store: RunBundleStore,
  policy = DEFAULT_RUN_BUNDLE_RETENTION,
  now = Date.now(),
): Promise<{ reclaimedBytes: number; prunedPaths: string[] }> {
  await assertStorePairing(store);
  assertPolicy(policy);
  return withRunBundleStoreLock(store, async () => {
    const referenced = new Set<string>();
    const activeRuns = new Set<string>();
    const pinned = new Set<string>();
    const retain = (ref: RunArtifactBundleRef | undefined, pin: boolean) => {
      if (!ref || ref.storeId !== store.id) return;
      referenced.add(ref.bundleDigest);
      if (pin) pinned.add(ref.bundleDigest);
    };
    for (const run of loadAllRunRecords(store.runsDir)) {
      const active = !['done', 'failed', 'cancelled'].includes(run.status);
      if (active) activeRuns.add(run.id);
      retain(run.artifactBundle, active);
      retain(run.output?.artifactBundle, active);
      for (const decision of run.decisions) {
        if (decision.payload?.kind === 'output-review')
          retain(
            decision.payload.artifactBundle ??
              (decision.payload.manifestDigest === run.output?.manifestDigest
                ? run.output.artifactBundle
                : undefined),
            !decision.resolvedAt,
          );
        if (decision.payload?.kind === 'ready')
          retain(
            decision.payload.prPackage?.artifactBundle,
            !decision.resolvedAt ||
              ['published_draft', 'published_ready'].includes(
                decision.payload.prPackage?.publicationStatus ?? '',
              ),
          );
      }
    }
    const intentsDir = path.join(store.runsDir, 'bundle-intents');
    await mkdir(intentsDir, { recursive: true });
    const activeStages = new Set<string>();
    for (const file of await readdir(intentsDir)) {
      if (!file.endsWith('.json')) continue;
      const intent: CaptureIntent = JSON.parse(await readFile(path.join(intentsDir, file), 'utf8'));
      if (!intent.committed) {
        if (!activeRuns.has(intent.runId) && now - Date.parse(intent.exportedAt) > 86_400_000) {
          await rm(path.join(intentsDir, file));
          continue;
        }
        activeStages.add(intent.bundleId);
        if (intent.bundleDigest) pinned.add(intent.bundleDigest);
      }
    }
    let reclaimedBytes = 0;
    const prunedPaths: string[] = [];
    const digestRoot = path.join(store.root, 'sha256');
    await mkdir(digestRoot, { recursive: true });
    for (const digest of await readdir(digestRoot)) {
      const directory = bundleDirectory(store, digest);
      if (pinned.has(digest)) continue;
      if (!referenced.has(digest)) {
        reclaimedBytes += await physicalBytes(directory);
        await rm(directory, { recursive: true });
        manifestCache.delete(`${store.id}:${digest}`);
        continue;
      }
      const manifest = parseManifest(directory);
      if (now - Date.parse(manifest.exportedAt) < policy.mediaRetentionDays * 86_400_000) continue;
      const removed: string[] = [];
      for (const [key, meta] of Object.entries(manifest.entries)) {
        if (!isRunBundleMedia(key)) continue;
        const file = resolvePathInsideRoot(directory, key);
        try {
          await rm(file);
          reclaimedBytes += meta.bytes;
          removed.push(key);
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
        }
      }
      if (removed.length) {
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
    const stagingRoot = path.join(store.root, 'staging');
    await mkdir(stagingRoot, { recursive: true });
    for (const name of await readdir(stagingRoot)) {
      assertSafeBundleSegment(name, 'staging id');
      const directory = path.join(stagingRoot, name);
      if (activeStages.has(name) || now - (await stat(directory)).mtimeMs < 86_400_000) continue;
      reclaimedBytes += await physicalBytes(directory);
      await rm(directory, { recursive: true });
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
  return withRunBundleStoreLock(store, async () => {
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
        await rename(stage, destination);
      }
      const retained = await readRetainedRunBundle(store, ref, run.id);
      const missingData = await completeRetainedPayloads(
        request,
        ref,
        retained.directory,
        retained.manifest,
      );
      await request.commit(ref, missingData);
      intent.committed = true;
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
    let storeBytes =
      (await physicalBytes(store.root)) +
      (await reservedMetadataBytes(store, run.id)) +
      (request.stagingBytes ?? 0);
    const taskRoot = await realpath(request.taskDir);
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
        const source = resolvePathInsideRoot(taskRoot, artifact.path);
        let size: number;
        try {
          if ((await realpath(source)) !== source || !(await lstat(source)).isFile())
            throw new Error(`Artifact is redirected: ${artifact.path}`);
          size = (await stat(source)).size;
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
          missingData.push(`missing:${artifact.path}`);
          continue;
        }
        const media = isRunBundleMedia(artifact.path);
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
          if (artifact.sha256) {
            const key = `tasks/${taskKey}/${artifact.path}`;
            manifest.entries[key] = {
              path: key,
              sha256: artifact.sha256.replace(/^sha256:/u, ''),
              bytes: size,
            };
          }
          missingData.push(`media-capacity:${artifact.path}`);
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
        storeBytes += copied.bytes;
      }
      if (missingData.length) manifest.missingData = missingData;
      const raw = `${JSON.stringify(manifest, null, 2)}\n`;
      if (
        bundleBytes + Buffer.byteLength(raw) > policy.maxBundleBytes ||
        storeBytes + Buffer.byteLength(raw) > policy.maxStoreBytes
      )
        throw new Error('Run bundle manifest exceeds reserved capacity.');
      await writeFile(path.join(stage, runPath), intent.runJson, { mode: 0o400 });
      await writeFile(path.join(stage, 'manifest.json'), raw, { mode: 0o400 });
      const bundleDigest = sha256Text(raw);
      const destination = bundleDirectory(store, bundleDigest);
      await mkdir(path.dirname(destination), { recursive: true });
      // Persist identity before publishing, so a crash in the reference commit reuses it.
      intent.bundleDigest = bundleDigest;
      await atomicJson(intentPath, intent);
      await rename(stage, destination);
      const ref: RunArtifactBundleRef = {
        storeId: store.id,
        bundleDigest,
        taskKey,
        manifestDigest: request.manifestDigest,
      };
      await request.commit(ref, missingData);
      intent.committed = true;
      intent.runJson = '';
      await atomicJson(intentPath, intent);
      await rm(path.join(store.root, 'reservations', `${run.id}.json`), { force: true });
      return { ref, manifest, missingData };
    } catch (error) {
      // Keep a published capture pinned by its persisted intent until commit/recovery.
      if (!intent.bundleDigest) await rm(stage, { recursive: true, force: true });
      throw error;
    }
  });
}
