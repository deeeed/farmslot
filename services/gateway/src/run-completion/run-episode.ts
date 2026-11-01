// run-episode.ts — one small episode record per finished run (ADR-039 Amendment 4).
//
// An episode names what a run consumed and produced, as input, trajectory and
// labels, so offline tools can learn from every run without reconstructing it
// from side stores. It holds references, never copies: each file is its
// task-relative path plus the sha256 that the output inventory or a retained
// bundle manifest already recorded. Nothing here reads or hashes an artifact.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentContext,
  isTerminalRunStatus,
  type Run,
  type RunArtifactBundleRef,
  type RunBundleEntryMeta,
} from '@farmslot/protocol';
import {
  isRunBundleMedia,
  readRetainedRunBundle,
  resolveRetainedRunBundleRef,
  runBundleRefs,
} from '@farmslot/run-bundle';

import { writeAtomicJSON } from '../core/atomic-json.js';
import { runsDirectory } from '../runs/store.js';

export const RUN_EPISODE_SCHEMA = 'farmslot-episode-v1';
/** The first retry pass after an upgrade covers runs that ended this long before it. */
const FIRST_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunEpisodeFile {
  /** Task-relative path, e.g. `artifacts/recipe-runs/<id>/summary.json`. */
  path: string;
  sha256: string;
  bytes?: number;
  /** Digest of the retained bundle holding these bytes; absent when only the inventory names them. */
  bundle?: string;
}

export interface RunEpisode {
  schema: typeof RUN_EPISODE_SCHEMA;
  runId: string;
  capturedAt: string;
  /** The run revision this episode describes; a later run update re-captures it. */
  runUpdatedAt: string;
  project: string;
  flowType: Run['flowType'];
  status: Run['status'];
  input: {
    ticket: string;
    summary?: string;
    branch?: string | null;
    startRef?: string;
    dispatchHead?: string | null;
    pr?: { repo?: string; number: number };
    files: RunEpisodeFile[];
  };
  trajectory: {
    recipes: RunEpisodeFile[];
    /** One entry per recipe-run directory, in path order. */
    recipeRuns: { dir: string; files: RunEpisodeFile[] }[];
    agents: (Pick<AgentContext, 'role' | 'runner' | 'model' | 'runnerSessionId'> & {
      archive?: { relativeDir?: string; sha256?: string; sizeBytes?: number };
    })[];
    steps: { name: string; status: string; startedAt?: string; completedAt?: string }[];
    recoveryAttempts: number;
  };
  labels: {
    outcome?: string;
    failedStep?: string;
    error?: string;
    decisions: { type: string; resolvedAction?: string; resolvedAt?: string }[];
    reviews: RunEpisodeFile[];
    recipeQuality: RunEpisodeFile[];
    evidence: RunEpisodeFile[];
  };
  /**
   * The pinned recipe sources the run executed: the provider package and each
   * library revision, copied from the task's recipe binding (ADR-069); null
   * when the task has no binding. Never inferred from text.
   */
  provenance: RunEpisodeProvenance | null;
  sources: {
    bundles: string[];
    unreadableBundles: UnreadableEpisodeBundle[];
    /** Inventory entries without a recorded sha256, left out rather than hashed now. */
    undigested: number;
    /** Media files are counted, not listed; their retention follows the bundle policy. */
    media: number;
  };
}

export interface RunEpisodeProvenance {
  /** Task-relative file the values were copied from. */
  source: typeof RECIPE_BINDING_FILE;
  harness: { package: string; version: string } | null;
  /** `revision` is the library's git commit; a packaged library has only its fingerprint. */
  libraries: { name: string; revision: string | null; fingerprint: string | null }[];
}

/** The binding fields the episode copies; written by task init on the node. */
export interface RecipeBindingDocument {
  provider?: { package?: string; version?: string };
  identity?: {
    libraries?: { name?: string; head?: string | null; sourceFingerprint?: string | null }[];
  };
}

export const RECIPE_BINDING_FILE = 'inputs/recipe-binding.json';

/** A referenced bundle whose manifest could not be read, with the reason. */
export interface UnreadableEpisodeBundle {
  digest: string;
  error: string;
}

export interface EpisodeBundle {
  digest: string;
  taskKey: string;
  entries: Record<string, RunBundleEntryMeta>;
}

const EVIDENCE_FILES = new Set([
  'evidence-manifest.json',
  'acceptance-status.json',
  'artifact-manifest.json',
  'latest-valid-recipe-run.json',
]);
const INPUT_FILES = new Set(['TASK.md', 'CHECKLIST.md']);

function isRecipeDocument(base: string, file: string): boolean {
  return (
    base === 'recipe.json' ||
    base.endsWith('.recipe.json') ||
    base === 'recipe-resolution.json' ||
    file.includes('/recipe-library/')
  );
}

/** The run's referenced files, by task-relative path; a retained copy wins over an inventory-only entry. */
function collectFiles(
  run: Run,
  bundles: readonly EpisodeBundle[],
): { files: Map<string, RunEpisodeFile>; undigested: number } {
  const files = new Map<string, RunEpisodeFile>();
  for (const bundle of bundles) {
    const prefix = `tasks/${bundle.taskKey}/`;
    for (const [key, meta] of Object.entries(bundle.entries)) {
      if (!key.startsWith(prefix)) continue;
      const file = key.slice(prefix.length);
      if (!files.has(file))
        files.set(file, {
          path: file,
          sha256: meta.sha256,
          bytes: meta.bytes,
          bundle: bundle.digest,
        });
    }
  }
  let undigested = 0;
  for (const entry of run.output?.artifactManifest ?? []) {
    if (files.has(entry.path)) continue;
    if (!entry.sha256) {
      undigested++;
      continue;
    }
    files.set(entry.path, { path: entry.path, sha256: entry.sha256, bytes: entry.sizeBytes });
  }
  return { files, undigested };
}

export function buildRunEpisode(
  run: Run,
  bundles: readonly EpisodeBundle[],
  unreadableBundles: readonly UnreadableEpisodeBundle[],
  capturedAt: string,
  binding?: RecipeBindingDocument,
): RunEpisode {
  const { files, undigested } = collectFiles(run, bundles);
  const paths = [...files.keys()].sort();
  const present = new Set(paths);
  // A recipe-run directory holds a summary next to its recipe or trace.
  const runDirs = paths
    .filter((file) => path.posix.basename(file) === 'summary.json')
    .map((file) => path.posix.dirname(file))
    .filter((dir) => present.has(`${dir}/recipe.json`) || present.has(`${dir}/trace.json`));
  const recipeRuns = runDirs.map((dir) => ({ dir, files: [] as RunEpisodeFile[] }));
  const inputs: RunEpisodeFile[] = [];
  const recipes: RunEpisodeFile[] = [];
  const reviews: RunEpisodeFile[] = [];
  const recipeQuality: RunEpisodeFile[] = [];
  const evidence: RunEpisodeFile[] = [];
  let media = 0;
  for (const file of paths) {
    const ref = files.get(file)!;
    const base = path.posix.basename(file);
    if (isRunBundleMedia(file)) {
      media++;
      continue;
    }
    // Evidence and acceptance manifests are labels wherever they sit, including inside an attempt.
    if (EVIDENCE_FILES.has(base)) evidence.push(ref);
    const owner = recipeRuns.find(({ dir }) => file.startsWith(`${dir}/`));
    if (owner) owner.files.push(ref);
    else if (base.includes('review-result') && base.endsWith('.json')) reviews.push(ref);
    else if (base.startsWith('recipe-quality')) recipeQuality.push(ref);
    else if (EVIDENCE_FILES.has(base)) continue;
    else if (isRecipeDocument(base, file)) recipes.push(ref);
    else if (
      INPUT_FILES.has(base) ||
      base.endsWith('.diff') ||
      base.endsWith('action-manifest.json')
    )
      inputs.push(ref);
  }
  const publication = run.prPublications?.at(-1)?.pr;
  const pr = publication
    ? { repo: publication.repo, number: publication.number }
    : run.prNumber !== undefined
      ? { number: run.prNumber }
      : undefined;
  return {
    schema: RUN_EPISODE_SCHEMA,
    runId: run.id,
    capturedAt,
    runUpdatedAt: run.updatedAt,
    project: run.project,
    flowType: run.flowType,
    status: run.status,
    input: {
      ticket: run.ticketOrPr,
      summary: run.summary,
      branch: run.branch,
      startRef: run.startRef?.resolvedSha ?? run.startRef?.requestedRef,
      dispatchHead: run.worktreeHeadAtDispatch,
      pr,
      files: inputs,
    },
    trajectory: {
      recipes,
      recipeRuns,
      agents: (run.agentContexts ?? []).map((context) => ({
        role: context.role,
        runner: context.runner,
        model: context.model,
        runnerSessionId: context.runnerSessionId,
        archive: context.runnerSessionArchive && {
          relativeDir: context.runnerSessionArchive.relativeDir,
          sha256: context.runnerSessionArchive.sha256,
          sizeBytes: context.runnerSessionArchive.sizeBytes,
        },
      })),
      steps: run.steps.map(({ name, status, startedAt, completedAt }) => ({
        name,
        status,
        startedAt,
        completedAt,
      })),
      recoveryAttempts: run.recoveryAttempts?.length ?? 0,
    },
    labels: {
      outcome: run.metrics?.outcome,
      failedStep: run.steps.find((step) => step.status === 'failed')?.name,
      error: run.error,
      decisions: run.decisions.map(({ type, resolvedAction, resolvedAt }) => ({
        type,
        resolvedAction,
        resolvedAt,
      })),
      reviews,
      recipeQuality,
      evidence,
    },
    provenance: binding ? episodeProvenance(binding) : null,
    sources: {
      bundles: bundles.map(({ digest }) => digest),
      unreadableBundles: [...unreadableBundles],
      undigested,
      media,
    },
  };
}

function episodeProvenance(binding: RecipeBindingDocument): RunEpisodeProvenance {
  const { package: name, version } = binding.provider ?? {};
  return {
    source: RECIPE_BINDING_FILE,
    harness: name && version ? { package: name, version } : null,
    libraries: (binding.identity?.libraries ?? [])
      .filter((library) => typeof library.name === 'string')
      .map((library) => ({
        name: library.name!,
        revision: library.head ?? null,
        fingerprint: library.sourceFingerprint ?? null,
      })),
  };
}

export function runEpisodeDir(): string {
  return path.join(runsDirectory(), 'episodes');
}

function episodeFile(runId: string): string {
  if (!runId || path.basename(runId) !== runId)
    throw new Error(`Invalid run id for episode: ${runId}`);
  return path.join(runEpisodeDir(), `${runId}.json`);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readRunEpisode(runId: string): Promise<RunEpisode | undefined> {
  return readJson<RunEpisode>(episodeFile(runId));
}

/** Writes the run's episode; returns null for a run that has not ended. */
export async function captureRunEpisode(run: Run, now = new Date()): Promise<RunEpisode | null> {
  if (!isTerminalRunStatus(run.status)) return null;
  const refs = new Map<string, RunArtifactBundleRef>();
  for (const { ref } of runBundleRefs(run)) {
    const local = resolveRetainedRunBundleRef(run, ref);
    refs.set(local.bundleDigest, local);
  }
  const bundles: EpisodeBundle[] = [];
  const unreadable: UnreadableEpisodeBundle[] = [];
  if (refs.size) {
    // Loaded on demand: the transition modules that run this effect must not pull in capture.
    const { runBundleStore } = await import('./retained-artifacts.js');
    const store = await runBundleStore();
    for (const ref of refs.values()) {
      try {
        // Reads and verifies the small manifest only; payload bytes are never opened.
        const snapshot = await readRetainedRunBundle(store, ref, run.id);
        bundles.push({
          digest: ref.bundleDigest,
          taskKey: ref.taskKey,
          entries: snapshot.manifest.entries,
        });
      } catch (error) {
        // A moved, pruned or foreign bundle must not lose the episode: its digest and reason
        // are recorded, and the inventory still names the files.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[run-episode] ${run.id}: bundle ${ref.bundleDigest} unreadable: ${message}`);
        unreadable.push({ digest: ref.bundleDigest, error: message });
      }
    }
  }
  // The binding is a small JSON file the gateway's task copy already holds. An
  // unreadable one leaves provenance null rather than losing the episode.
  const binding = run.taskFile
    ? await readJson<RecipeBindingDocument>(
        path.join(path.dirname(run.taskFile), RECIPE_BINDING_FILE),
      ).catch((error: unknown) => {
        console.warn(`[run-episode] ${run.id}: recipe binding unreadable: ${String(error)}`);
        return undefined;
      })
    : undefined;
  const episode = buildRunEpisode(run, bundles, unreadable, now.toISOString(), binding);
  await writeAtomicJSON(episodeFile(run.id), episode);
  return episode;
}

/**
 * The hourly retry: capture every ended run updated since the last pass whose
 * episode is missing or describes an older revision. Only recently updated runs
 * are visited. A failure keeps the watermark at that run, so the next pass
 * retries it. `now` must be taken before `runs` was loaded, so an update in
 * between is seen by the next pass.
 */
export async function captureMissingRunEpisodes(
  runs: readonly Run[],
  now = Date.now(),
): Promise<{ captured: number; failed: number }> {
  const watermarkFile = path.join(runEpisodeDir(), 'watermark.json');
  const since =
    (await readJson<{ since: number }>(watermarkFile))?.since ?? now - FIRST_RETRY_WINDOW_MS;
  let captured = 0;
  let failed = 0;
  let oldestFailure: number | undefined;
  for (const run of runs) {
    if (!isTerminalRunStatus(run.status)) continue;
    const updated = Date.parse(run.updatedAt);
    if (!(updated >= since)) continue;
    try {
      if ((await readRunEpisode(run.id))?.runUpdatedAt === run.updatedAt) continue;
      await captureRunEpisode(run);
      captured++;
    } catch (error) {
      failed++;
      oldestFailure = Math.min(oldestFailure ?? updated, updated);
      console.error(`[run-episode] capture failed for ${run.id}: ${(error as Error).message}`);
    }
  }
  await writeAtomicJSON(watermarkFile, { since: oldestFailure ?? now });
  return { captured, failed };
}
