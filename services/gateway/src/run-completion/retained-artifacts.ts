import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  readRecordedEvidencePackage,
  type RecordedEvidencePackageReadIO,
} from '@farmslot/adapter-sdk';
import {
  type ArtifactRef,
  decisionArtifactBundleRef,
  INHERITED_ACCEPTANCE_INPUT,
  isRecord,
  isTerminalRunStatus,
  type RecipeRunArtifactGroup,
  type Run,
  type RunArtifactBundleRef,
  type RunBundleRetainResult,
  type RunBundleRetentionPolicy,
  sanitizeLatestValidRecipeRunPointer,
  WORKER_TERMINAL_CONTRACT_INPUT,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { strictTaskRelativePathFromFarmslotRoot } from '@farmslot/protocol/runs/portable-bundle';
import {
  type AcquisitionTaskDirToken,
  DEFAULT_RUN_BUNDLE_RETENTION,
  isRunBundleMedia,
  type MaterializedRunBundle,
  materializeRunBundle,
  type MaterializeRunBundleRequest,
  openRunBundleStore,
  parseRunBundleMissingData,
  readRetainedRunBundle,
  readRunBundleAvailability,
  reserveRunBundleMetadata,
  resolveRetainedRunBundleRef as localBundleRef,
  runBundleAdmissionUsage,
  runBundleHousekeepingPaths,
  runBundleRefs,
  withRunBundleStoreLock,
} from '@farmslot/run-bundle';

import { reportGatewayWarning } from '../chat/copilot-observer.js';
import { sha256File } from '../core/file-hash.js';
import { inferArtifactPurpose } from '../core/index.js';
import { isolatedTestPath } from '../core/isolated-test-path.js';
import { GatewayMethodError } from '../core/method-error.js';
import {
  ORCHESTRATOR_LOCALITY,
  type SlotCopyAdmission,
  slotCopyFile,
  slotFileFingerprint,
  type SlotLocality,
} from '../core/slot-io.js';
import { loadContextFromArtifactRoot } from '../live-recipe/context.js';
import { farmslotRoot } from '../projects/repo-root.js';
import {
  getAllRunsWithArchived,
  getRun,
  getRunWithArchived,
  isTaskDirectoryAdmitting,
  persistRunNow,
  recordRunStorageArchive,
  runsDirectory,
  runTaskDirectories,
  shouldUseIsolatedRunsDir,
  updateRun,
} from '../runs/store.js';

export interface RunArtifactAcquisition {
  readonly media: ArtifactRef[];
  beforeCopy(locality: SlotLocality): SlotCopyAdmission;
  acquireMedia: NonNullable<MaterializeRunBundleRequest['acquireMedia']>;
}

/** Writer-only IO: retain metadata before asking a slot to transfer its media. */
export function createRunArtifactAcquisition(run: Run): RunArtifactAcquisition {
  if (!run.taskFile) throw new Error('Artifact acquisition requires a task directory.');
  const taskFile = run.taskFile;
  const generation = run.engineState?.generation;
  const taskDir = path.dirname(taskFile);
  const media = new Map<string, ArtifactRef>();
  const sources = new Map<string, { locality: SlotLocality; source: string }>();
  const assertCurrent = () => {
    const current = getRun(run.id);
    if (!current || current.taskFile !== taskFile || current.engineState?.generation !== generation)
      throw new Error('Run attempt changed while acquiring retained media.');
  };
  return {
    get media() {
      return [...media.values()];
    },
    beforeCopy: (locality) => async (source, destination) => {
      const relative = path.relative(taskDir, destination).split(path.sep).join('/');
      if (!isRunBundleMedia(relative)) return true;
      if (relative.startsWith('../') || path.isAbsolute(relative))
        throw new Error('Artifact acquisition escapes its task.');
      assertCurrent();
      const identity = await slotFileFingerprint(locality, source);
      const previous = media.get(relative);
      if (previous?.sha256 && previous.sha256 !== identity.sha256)
        throw new Error('Media changed during inventory acquisition.');
      media.set(relative, {
        path: relative,
        purpose: inferArtifactPurpose(relative.replace(/^artifacts\//u, '')),
        sha256: identity.sha256,
        sizeBytes: identity.size,
      });
      sources.set(relative, { locality, source });
      return false;
    },
    acquireMedia: async (artifact, destination, maxBytes) => {
      assertCurrent();
      const source = sources.get(artifact.path) ?? {
        locality: ORCHESTRATOR_LOCALITY,
        source: path.join(taskDir, artifact.path),
      };
      await mkdir(path.dirname(destination), { recursive: true });
      await slotCopyFile(source.locality, source.source, destination, {
        maxBytes,
        phase: 'mirror',
        runId: run.id,
        slotId: run.slotId ?? undefined,
        label: artifact.path,
      });
      const identity = {
        sha256: await sha256File(destination),
        bytes: (await stat(destination)).size,
      };
      assertCurrent();
      return identity;
    },
  };
}

export function runBundleStore(create = false) {
  if (create && process.env.FARMSLOT_SANDBOX_HOME)
    throw new Error('Sandbox gateways may only read the owning gateway retained bundle store.');
  const home = process.env.FARMSLOT_HOME
    ? farmslotHome()
    : process.env.FARMSLOT_RUNS_DIR
      ? path.join(runsDirectory(), 'bundle-home')
      : shouldUseIsolatedRunsDir(process.env, process.argv)
        ? isolatedTestPath('farmslot-test-bundle-home')
        : farmslotHome();
  return openRunBundleStore({
    runsDir: runsDirectory(),
    home,
    create: create && !process.env.FARMSLOT_SANDBOX_HOME,
  });
}

export function retainedRunBundleRef(
  run: Run,
  decisionId?: string,
  digest?: string,
): RunArtifactBundleRef {
  const decision = decisionId ? run.decisions.find(({ id }) => id === decisionId) : undefined;
  const payload = decision?.payload;
  let selected = decisionId
    ? decisionArtifactBundleRef(run, payload)
    : (run.artifactBundle ?? run.output?.artifactBundle);
  if (decisionId && !decision) throw new Error('The retained decision no longer exists.');
  if (digest) {
    const known = runBundleRefs(run).map(({ ref }) => ref);
    const requested = known.find(
      (ref) =>
        ref && (ref.bundleDigest === digest || localBundleRef(run, ref).bundleDigest === digest),
    );
    if (
      decisionId &&
      (!selected ||
        !requested ||
        localBundleRef(run, selected).bundleDigest !== localBundleRef(run, requested).bundleDigest)
    )
      throw new Error('The requested retained snapshot does not match this decision.');
    selected = requested;
  }
  if (!selected)
    throw new GatewayMethodError('RUN_ARTIFACTS_NOT_RETAINED', 'Run artifacts are not retained.', {
      userAction: `farmslot runs bundle retain ${run.id}`,
    });
  return localBundleRef(run, selected);
}

export async function retainedRunTaskDirectory(
  run: Run,
  ref = retainedRunBundleRef(run),
): Promise<string> {
  ref = localBundleRef(run, ref);
  return (await readRetainedRunBundle(await runBundleStore(), ref, run.id)).taskDir;
}

/** Verify only the requested file, never all media just to open a report. */
export async function readRetainedRunText(
  run: Run,
  file: string,
  ref = retainedRunBundleRef(run),
): Promise<string> {
  ref = localBundleRef(run, ref);
  const bundle = await readRetainedRunBundle(await runBundleStore(), ref, run.id);
  return bundle.readText(file);
}

export async function retainedRunArtifactManifest(
  run: Run,
  ref = retainedRunBundleRef(run),
): Promise<ArtifactRef[]> {
  ref = localBundleRef(run, ref);
  const store = await runBundleStore();
  const { manifest, directory } = await readRetainedRunBundle(store, ref, run.id);
  const availability = await readRunBundleAvailability(store, ref, run.id);
  const pruned = new Set(availability.prunedPaths);
  const prefix = `tasks/${ref.taskKey}/`;
  const original = new Map(
    (run.output?.artifactManifest ?? []).map((artifact) => [artifact.path, artifact]),
  );
  return Promise.all(
    Object.entries(manifest.entries)
      .filter(([key]) => key.startsWith(prefix))
      .map(async ([key, entry]): Promise<ArtifactRef> => {
        const file = key.slice(prefix.length);
        let state: ArtifactRef['availability'] = pruned.has(key) ? 'pruned' : 'available';
        try {
          await stat(path.join(directory, key));
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            state = pruned.has(key) ? 'pruned' : 'missing';
          else throw error;
        }
        return {
          ...original.get(file),
          availability: state,
          retentionRevision: availability.revision,
          bundleDigest: ref.bundleDigest,
          path: file,
          purpose:
            original.get(file)?.purpose ?? inferArtifactPurpose(file.replace(/^artifacts\//u, '')),
          sha256: entry.sha256,
          sizeBytes: entry.bytes,
        };
      }),
  );
}

/** Optional retained metadata has one lookup policy shared by gate/report consumers. */
export async function readOptionalRetainedRunText(
  run: Run,
  file: string,
  selectedRef?: RunArtifactBundleRef,
): Promise<string | undefined> {
  if (!selectedRef && !run.artifactBundle && !run.output?.artifactBundle) return undefined;
  const ref = selectedRef ? localBundleRef(run, selectedRef) : retainedRunBundleRef(run);
  const bundle = await readRetainedRunBundle(await runBundleStore(), ref, run.id);
  if (!bundle.manifest.entries[`tasks/${ref.taskKey}/${file}`]) return undefined;
  return readRetainedRunText(run, file, ref);
}

/** Manifest-indexed I/O feeds the sole SDK package reader. Missing/pruned files remain failures. */
export async function retainedEvidenceReadIO(
  run: Run,
  root: string,
  ref = retainedRunBundleRef(run),
): Promise<RecordedEvidencePackageReadIO> {
  ref = localBundleRef(run, ref);
  const store = await runBundleStore();
  const bundle = await readRetainedRunBundle(store, ref, run.id);
  const prefix = `tasks/${ref.taskKey}/${root.replace(/\/$/u, '')}/`;
  const paths = Object.keys(bundle.manifest.entries)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  return {
    listPaths: async () => paths,
    readJson: async (relative) =>
      JSON.parse(await bundle.readText(path.posix.join(root, relative))),
    digestFile: async (relative) => {
      const entry = await bundle.resolveEntry(path.posix.join(root, relative));
      return `sha256:${entry.sha256}`;
    },
  };
}

export async function readRetainedEvidencePackage(
  run: Run,
  root: string,
  ref = retainedRunBundleRef(run),
) {
  return readRecordedEvidencePackage(root, await retainedEvidenceReadIO(run, root, ref));
}

async function retentionPolicy(): Promise<RunBundleRetentionPolicy> {
  const store = await runBundleStore();
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(path.dirname(store.root), 'run-bundle-retention.json'), 'utf8'),
    );
    if (!isRecord(value) || !isRecord(value.runBundleRetention))
      throw new Error('Invalid runBundleRetention settings.');
    const policy = { ...DEFAULT_RUN_BUNDLE_RETENTION };
    for (const key of Object.keys(policy) as Array<keyof RunBundleRetentionPolicy>) {
      const setting = value.runBundleRetention[key];
      if (setting !== undefined) {
        if (typeof setting !== 'number') throw new Error(`Invalid runBundleRetention.${key}`);
        policy[key] = setting;
      }
    }
    return policy;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { ...DEFAULT_RUN_BUNDLE_RETENTION };
    throw error;
  }
}

const RETAINED_TASK_INPUTS = [
  INHERITED_ACCEPTANCE_INPUT,
  'inputs/handoff.json',
  'inputs/commit.json',
  WORKER_TERMINAL_CONTRACT_INPUT,
];

/** Qualify bytes before existing local task/contract parsers consume the captured tree. */
export async function qualifyRetainedRunMetadata(run: Run): Promise<void> {
  for (const file of [
    ...RETAINED_TASK_INPUTS,
    'artifacts/acceptance-status.json',
    'artifacts/latest-valid-recipe-run.json',
  ])
    await readOptionalRetainedRunText(run, file);
}

/** Release admission reservations by archiving them, with the package owner selecting safe paths. */
export async function archiveRunArtifactHousekeeping(): Promise<void> {
  if (process.env.FARMSLOT_SANDBOX_HOME) return;
  const {
    runArchiveRoot,
    assertArchiveRoot,
    stageStoragePaths,
    finishStorageArchive,
    storageArchiveManifest,
  } = await import('../runs/storage-archive.js');
  const root = runArchiveRoot();
  const store = await runBundleStore(true);
  const staged = new Set<string>();
  await withRunBundleStoreLock(store, async () => {
    const entries = await runBundleHousekeepingPaths(store);
    if (!entries.length) return;
    await assertArchiveRoot(root);
    for (const entry of entries) {
      if (await getRunWithArchived(entry.runId))
        await recordRunStorageArchive(entry.runId, storageArchiveManifest(root, entry.runId));
      await stageStoragePaths(root, entry.runId, [{ source: entry.path, store: entry.store }]);
      staged.add(entry.runId);
    }
  });
  for (const id of staged) {
    try {
      await finishStorageArchive(root, id);
    } catch (error) {
      console.error(
        `[run-retention] housekeeping archive ${id} failed; source/journal retained: ${(error as Error).message}`,
      );
    }
  }
}

// Warn the farm well before capture admission refuses retained media at the store cap.
const RUN_BUNDLE_WARN_RATIO = 0.7;

// A run can still write its task dir just after its last update (slot release, staging media
// release, a grade), so a dir keeps its footprint only once its runs have been quiet this long.
const SETTLED_TASK_DIR_QUIET_MS = 15 * 60_000;

/**
 * Classifies gateway task dirs for acquisition accounting. A dir is live while a run naming it
 * has not ended, while it is being admitted, and until its runs have been quiet for a while. A
 * settled dir's token is its runs' ids and update times, so a later run update measures it
 * again. A dir no run names (a deleted run's) changes only when retention moves or removes it.
 */
export async function acquisitionTaskDirToken(now = Date.now()): Promise<AcquisitionTaskDirToken> {
  const owners = new Map<string, Run[]>();
  for (const run of await getAllRunsWithArchived())
    for (const directory of new Set(runTaskDirectories(run)))
      owners.set(directory, [...(owners.get(directory) ?? []), run]);
  return (directory) => {
    if (isTaskDirectoryAdmitting(directory)) return undefined;
    const runs = owners.get(path.resolve(directory));
    if (!runs) return 'unowned';
    if (
      runs.some(
        (run) =>
          !isTerminalRunStatus(run.status) ||
          !(now - Date.parse(run.updatedAt) >= SETTLED_TASK_DIR_QUIET_MS),
      )
    )
      return undefined;
    return runs
      .map((run) => `${run.id}@${run.updatedAt}`)
      .sort()
      .join(' ');
  };
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Whether admission's charged bytes call for a farm warning; pure so the threshold is testable. */
export function runBundleNearCapacity(
  chargedBytes: number,
  policy: Pick<RunBundleRetentionPolicy, 'maxStoreBytes'>,
): boolean {
  return chargedBytes >= policy.maxStoreBytes * RUN_BUNDLE_WARN_RATIO;
}

/** Hourly: warn the farm while there is still room, measured as admission charges it. Never throws. */
export async function warnRunBundleCapacity(): Promise<void> {
  try {
    const store = await runBundleStore(true);
    const policy = await retentionPolicy();
    const usage = await runBundleAdmissionUsage(
      store,
      farmslotRoot,
      await acquisitionTaskDirToken(),
    );
    if (runBundleNearCapacity(usage.total, policy))
      reportGatewayWarning(
        'run-bundle.capacity',
        `Run-bundle admission charges ${gib(usage.total)} of its ${gib(policy.maxStoreBytes)} cap (bundles ${gib(usage.store)}, reservations ${gib(usage.reservations)}, task trees ${gib(usage.acquisition)}); gates refuse retained media before the cap. Free storage or raise maxStoreBytes in run-bundle-retention.json.`,
      );
  } catch (error) {
    console.error(`[run-retention] run-bundle capacity check failed: ${(error as Error).message}`);
  }
}

/** Cleanup failure cannot discard a new run's report or bypass its normal capacity checks. */
async function tryArchiveRunArtifactHousekeeping(): Promise<void> {
  try {
    await archiveRunArtifactHousekeeping();
  } catch (error) {
    console.error(
      `[run-retention] housekeeping unavailable; bytes retained and normal capacity checks continue: ${(error as Error).message}`,
    );
  }
}

export async function reserveRunArtifactMetadata(run: Run): Promise<void> {
  // Completed dispatch is durable admission evidence, including pre-reservation runs.
  // Monitoring/review must consume existing work without another cold admission scan.
  if (run.steps.some((step) => step.name === 'dispatch' && step.status === 'done')) return;
  const store = await runBundleStore(true);
  const policy = await retentionPolicy();
  await persistRunNow(getRun(run.id) ?? run, 'retention admission');
  await tryArchiveRunArtifactHousekeeping();
  await reserveRunBundleMetadata(
    store,
    run.id,
    policy,
    farmslotRoot,
    await acquisitionTaskDirToken(),
  );
}

export async function retainCapturedRunArtifacts(input: {
  run: Run;
  artifacts: readonly ArtifactRef[];
  manifestDigest: string;
  allowChanged?: boolean;
  existingRef?: RunArtifactBundleRef;
  sourceRef?: RunArtifactBundleRef;
  /** Task-relative files the gateway wrote after `sourceRef`, read from the live task directory. */
  gatewayFiles?: readonly string[];
  acquireMedia?: MaterializeRunBundleRequest['acquireMedia'];
  releaseStagingMedia?: boolean;
  commit(ref: RunArtifactBundleRef, missingData: string[]): Promise<void>;
}): Promise<MaterializedRunBundle> {
  if (!input.run.taskFile) throw new Error('Run has no captured task artifacts.');
  const store = await runBundleStore(true);
  await tryArchiveRunArtifactHousekeeping();
  const artifacts = [...input.artifacts];
  // Task-local inputs are the frozen control metadata consumed by review and QA readers.
  // The materializer checks containment and hashes each file while copying it.
  const taskDir = input.sourceRef
    ? await retainedRunTaskDirectory(input.run, input.sourceRef)
    : path.dirname(input.run.taskFile);
  for (const directory of ['inputs', 'task-actions']) {
    try {
      for (const entry of await readdir(path.join(taskDir, directory), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const file = path
          .relative(taskDir, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join('/');
        if (!artifacts.some((artifact) => artifact.path === file))
          artifacts.push({
            path: file,
            purpose: 'task-input',
            ...(directory === 'task-actions'
              ? { sha256: await sha256File(path.join(taskDir, file)) }
              : {}),
            sizeBytes: (await stat(path.join(taskDir, file))).size,
          });
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  for (const file of [path.basename(input.run.taskFile), 'CHECKLIST.md', ...RETAINED_TASK_INPUTS]) {
    if (artifacts.some((artifact) => artifact.path === file)) continue;
    try {
      const bytes = await readFile(path.join(taskDir, file));
      artifacts.push({
        path: file,
        purpose: 'task-input',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return materializeRunBundle({
    store,
    farmslotRoot,
    acquisitionTaskDirToken: await acquisitionTaskDirToken(),
    run: input.run,
    artifacts,
    taskDir,
    gatewayFiles: input.gatewayFiles && {
      taskDir: path.dirname(input.run.taskFile),
      paths: input.gatewayFiles,
    },
    manifestDigest: input.manifestDigest,
    captureKey: JSON.stringify([
      input.run.taskFile,
      input.run.engineState?.generation,
      input.manifestDigest,
      ...artifacts
        .filter((artifact) => artifact.path.startsWith('task-actions/'))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ path, sha256 }) => [path, sha256]),
    ]),
    policy: await retentionPolicy(),
    allowChanged: input.allowChanged,
    acquireMedia: input.acquireMedia,
    existingRef: input.existingRef,
    commit: async (ref, missingData) => {
      const latest = getRun(input.run.id);
      if (
        latest &&
        latest.artifactBundle?.bundleDigest !== input.run.artifactBundle?.bundleDigest &&
        latest.artifactBundle?.bundleDigest !== ref.bundleDigest
      )
        throw new Error(
          'A newer retained capture committed while this snapshot was being acquired.',
        );
      await input.commit(ref, missingData);
      // Only the gateway's acquisition tree is regenerable. Slot trees and task inputs stay intact.
      if (
        input.releaseStagingMedia &&
        strictTaskRelativePathFromFarmslotRoot(farmslotRoot, input.run.taskFile)
      ) {
        const unavailable = new Set(
          missingData.map((entry) => parseRunBundleMissingData(entry).path),
        );
        for (const artifact of input.artifacts) {
          // Quota-deferred, changed or unidentified media may be the last source copy.
          if (
            !isRunBundleMedia(artifact.path) ||
            !artifact.sha256 ||
            unavailable.has(artifact.path)
          )
            continue;
          await rm(path.join(path.dirname(input.run.taskFile!), artifact.path), { force: true });
        }
      }
    },
  });
}

/** Explicit backfill preserves the captured inventory and every historical decision/verdict. */
export async function retainRunArtifacts(runId: string): Promise<RunBundleRetainResult> {
  const run = getRun(runId);
  if (!run?.taskFile || !run.output)
    throw new Error('Run has no captured output inventory to retain.');
  const output = run.output;
  if (output.artifactBundle) {
    const bundle = await readRetainedRunBundle(
      await runBundleStore(),
      localBundleRef(run, output.artifactBundle),
      run.id,
    );
    const entries = Object.keys(bundle.manifest.entries);
    const present = await Promise.all(
      entries.map(async (file) => {
        try {
          await stat(path.join(bundle.directory, file));
          return true;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
          throw error;
        }
      }),
    );
    if (present.every(Boolean))
      return {
        ref: output.artifactBundle,
        missingData: output.retentionMissingData ?? bundle.manifest.missingData ?? [],
      };
  }
  const acquisition = createRunArtifactAcquisition(run);
  // Acquisition is explicit. A viewer never refreshes a mirror or asks a slot for files.
  const missing = await Promise.all(
    output.artifactManifest.map(async (artifact) => {
      try {
        await stat(path.join(path.dirname(run.taskFile!), artifact.path));
        return false;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
        throw error;
      }
    }),
  );
  if (missing.some(Boolean) && run.slotId) {
    const { refreshArtifactMirror } = await import('./artifact-mirror.js');
    await refreshArtifactMirror(run, { acquisition });
  }
  const result = await retainCapturedRunArtifacts({
    run,
    artifacts: output.artifactManifest,
    acquireMedia: acquisition.acquireMedia,
    manifestDigest: output.manifestDigest,
    allowChanged: true,
    existingRef: output.artifactBundle,
    releaseStagingMedia: true,
    commit: async (ref, missingData) => {
      const current = getRun(runId);
      if (
        !current ||
        current.taskFile !== run.taskFile ||
        current.engineState?.generation !== run.engineState?.generation ||
        current.output?.manifestDigest !== output.manifestDigest
      )
        throw new Error('Run output changed during retention. Retry the current snapshot.');
      const updated = updateRun(runId, {
        artifactBundle: ref,
        output: { ...current.output, artifactBundle: ref, retentionMissingData: missingData },
      });
      await persistRunNow(updated, 'retained artifact backfill');
    },
  });
  return { ref: result.ref, missingData: result.missingData };
}

interface RetainedRecipeRunSummary {
  root: string;
  raw: unknown;
  recipeRunId: string | null;
  promoted: boolean;
}

/** One metadata selection policy for retained reports and inherited recipe inputs. */
export async function retainedRecipeRunSummaries(run: Run, ref = retainedRunBundleRef(run)) {
  const inventory = await retainedRunArtifactManifest(run, ref);
  const paths = new Set(inventory.map(({ path }) => path));
  const pointer = paths.has('artifacts/latest-valid-recipe-run.json')
    ? sanitizeLatestValidRecipeRunPointer(
        JSON.parse(await readRetainedRunText(run, 'artifacts/latest-valid-recipe-run.json', ref)),
      )
    : null;
  const roots = [
    ...new Set(
      inventory
        .filter(({ path: file }) => path.posix.basename(file) === 'summary.json')
        .map(({ path: file }) => path.posix.dirname(file)),
    ),
  ];
  const summaries: RetainedRecipeRunSummary[] = [];
  for (const root of ['artifacts', ...roots.filter((root) => root !== 'artifacts')]) {
    let raw: unknown = null;
    if (paths.has(`${root}/summary.json`)) {
      const text = await readRetainedRunText(run, `${root}/summary.json`, ref);
      try {
        raw = JSON.parse(text);
      } catch (error) {
        // A malformed execution must not hide the run's report. The canonical package reader reports it.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const recipeRunId =
      isRecord(raw) && typeof raw.recipeRunId === 'string' ? raw.recipeRunId : null;
    const promoted = Boolean(pointer && root === `artifacts/${pointer.relativeArtifactRoot}`);
    summaries.push({ root, raw, recipeRunId, promoted });
  }
  return { inventory, summaries };
}

/** Group discovery uses only the immutable manifest and lightweight execution metadata. */
export async function retainedRecipeRunGroups(
  run: Run,
  ref = retainedRunBundleRef(run),
): Promise<RecipeRunArtifactGroup[]> {
  const { inventory, summaries } = await retainedRecipeRunSummaries(run, ref);
  const taskDir = await retainedRunTaskDirectory(run, ref);
  const paths = new Set(inventory.map(({ path }) => path));
  const groups: RecipeRunArtifactGroup[] = [];
  for (const { root, raw, recipeRunId, promoted } of summaries) {
    const artifacts = inventory
      .filter(({ path: file }) => file.startsWith(`${root}/`))
      .map((artifact) => ({
        ...artifact,
        path: `artifacts/${artifact.path.slice(root.length + 1)}`,
      }));
    const context = await loadContextFromArtifactRoot({
      run,
      artifactRoot: path.join(taskDir, root),
      recipeRunId,
      source: 'recipe-run-artifacts',
      selectionReason: 'latest-run',
      isStale: false,
      retained: {
        artifactManifest: artifacts,
        readText: async (relative) =>
          paths.has(`${root}/${relative}`)
            ? readRetainedRunText(run, `${root}/${relative}`, ref)
            : null,
      },
    });
    groups.push({
      source: 'recipe-run-artifacts',
      selectionReason: 'latest-run',
      isStale: false,
      recipeRunId,
      artifactRoot: path.join(taskDir, root),
      artifactManifest: artifacts,
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      ...context,
      artifactBundle: ref,
      id: root === 'artifacts' ? 'current-artifacts' : (recipeRunId ?? root),
      label:
        root === 'artifacts'
          ? 'Retained run artifacts'
          : promoted
            ? 'Latest passing evidence'
            : root.slice('artifacts/'.length),
      groupKind:
        root === 'artifacts' ? 'current-artifacts' : promoted ? 'latest-valid' : 'live-run',
      promoted,
      status:
        isRecord(raw) && (raw.status === 'pass' || raw.status === 'fail') ? raw.status : 'unknown',
    });
  }
  return groups;
}

export function selectedRetainedRecipeGroup<
  T extends Pick<RecipeRunArtifactGroup, 'promoted' | 'recipeRunId'>,
>(groups: T[]): T | undefined {
  return (
    groups.find((group) => group.promoted) ?? groups.find((group) => group.recipeRunId) ?? groups[0]
  );
}

/** Presentation reads get a retained task root without rewriting lifecycle authority. */
export async function retainedArtifactRun(run: Run): Promise<Run> {
  if (!run.artifactBundle && !run.output?.artifactBundle)
    return { ...run, taskFile: null, liveRecipeContext: null };
  const taskDir = await retainedRunTaskDirectory(run);
  return {
    ...run,
    taskFile: path.join(taskDir, path.basename(run.taskFile ?? 'TASK.md')),
    liveRecipeContext: null,
  };
}
