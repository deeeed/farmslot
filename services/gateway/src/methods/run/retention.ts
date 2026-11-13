import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { runBundleRetentionSettings, withRunBundleStoreLock } from '@farmslot/run-bundle';

import { projectTaskRoots } from '../../core/config.js';
import { ownsRunSlotCleanup, readSlotRow } from '../../core/index.js';
import { getFamilyRuns, isFollowUpFlow } from '../../family-observability/context.js';
import { loadProjectConfig } from '../../fleet/state.js';
import { github } from '../../integrations/github-client.js';
import { reviewPRIdentity } from '../../review/session-mode.js';
import { reclaimReviewWorkspaceStorage } from '../../review-workspaces/storage-use.js';
import {
  archiveRunArtifactHousekeeping,
  runBundleHome,
  runBundleStore,
  warnRunBundleCapacity,
} from '../../run-completion/retained-artifacts.js';
import { captureMissingRunEpisodes } from '../../run-completion/run-episode.js';
import { parkedWorkRetentionPass } from '../../run-lifecycle/parked-work-retention.js';
import { nativeSessionManager } from '../../runners/native/manager.js';
import {
  DAY_MS,
  diskBytes,
  planRunRetention,
  retentionStoreAction,
  retiredTaskPins,
  runIsSettled,
  runOwnedPaths,
  type RunPrState,
  type RunRetentionContext,
  runRetentionHold,
  type RunRetentionPlan,
  type RunRetentionRoots,
  type RunRetentionStore,
} from '../../runs/retention.js';
import {
  assertArchiveRoot,
  keepStorageDeletions,
  resumeStorageArchives,
  runArchiveRoot,
  stageStoragePaths,
  storageArchiveManifest,
  type StorageDeletion,
} from '../../runs/storage-archive.js';
import {
  getAllRuns,
  getAllRunsWithArchived,
  getCachedRunWithArchived,
  getRunWithArchived,
  isTaskDirectoryAdmitting,
  recordRunStorageArchive,
  runsDirectory,
  runSessionArchiveDir,
  runTaskDirectories,
} from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;
const RUN_RETENTION_FIRST_PASS_MS = 10 * 60 * 1000;
const RUN_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const OPEN_PR_PAGE = 1000;

export async function gatewayRetentionRoots(): Promise<RunRetentionRoots> {
  const store = await runBundleStore();
  return {
    archiveRoot: runArchiveRoot(),
    runsDir: runsDirectory(),
    sessionArchive: runSessionArchiveDir,
    taskRoots: [
      ...(await projectTaskRoots()).map(({ root }) => root),
      path.join(runsDirectory(), 'review-workspace-tasks'),
    ],
    taskPins: currentFarmPaths('gateway').state.taskPins,
    nativeSessions: nativeSessionManager.root,
    reviewWorkspaces: path.join(path.dirname(nativeSessionManager.root), 'review-workspaces'),
    bundles: { id: store.id, root: store.root },
  };
}

async function readOpenPrs(repo: string): Promise<number[]> {
  // Pages to the limit, newest first, like `gh pr list --limit`; a full page reads as possibly truncated.
  const prs = await github.prList(
    repo,
    { state: 'open', limit: OPEN_PR_PAGE },
    { caller: 'run-retention' },
  );
  return prs.flatMap((pr) => (typeof pr.number === 'number' ? [pr.number] : []));
}

async function projectRepo(project: string): Promise<string | undefined> {
  return (await loadProjectConfig(project))?.ci?.repo;
}

const prRecordedSettled = (run: Run) =>
  Boolean(run.mergedAt) || run.prState === 'MERGED' || run.prState === 'CLOSED';

/**
 * Each run's PR state for this pass. Every identity a run has (the review-session identity,
 * and its own number in the project's repository) is checked against that repository's open
 * PRs, read once. Any open PR makes the state open, even when the run records it merged or
 * closed, since a PR can be reopened. Otherwise a recorded merge or close settles it; an
 * unresolvable identity, an unreadable repository or a possibly truncated list makes it unknown.
 *
 * An open or unknown PR keeps every run on it; the age rule applies to the others. Whatever the
 * PR state, an unsettled run holds what it still reads (`activeSourceHolds`).
 */
export async function retentionContext(
  runs: Run[],
  now = Date.now(),
  read: Pick<RunRetentionDeps, 'openPrs' | 'projectRepo' | 'retentionDays'> = RUN_RETENTION_DEPS,
): Promise<RunRetentionContext> {
  const identities = new Map<
    string,
    { prs: { repo: string; number: number }[]; unresolved: boolean }
  >();
  const projectRepos = new Map<string, string | undefined>();
  for (const run of runs) {
    const prs: { repo: string; number: number }[] = [];
    const review = reviewPRIdentity(run);
    if (review) prs.push({ repo: review.repository, number: review.prNumber });
    let unresolved =
      !review && Boolean(run.links?.some((link) => link.label.toLowerCase() === 'pr'));
    if (run.prNumber !== undefined) {
      if (run.project && !projectRepos.has(run.project))
        projectRepos.set(run.project, await read.projectRepo(run.project));
      const repo = run.project ? projectRepos.get(run.project) : undefined;
      if (repo) prs.push({ repo, number: run.prNumber });
      else if (review?.prNumber !== run.prNumber) unresolved = true;
    }
    if (prs.length || unresolved) identities.set(run.id, { prs, unresolved });
  }
  const open = new Map<string, Set<number> | undefined>();
  for (const repo of new Set(
    [...identities.values()].flatMap(({ prs }) => prs.map((pr) => pr.repo)),
  )) {
    try {
      const numbers = await read.openPrs(repo);
      open.set(repo, numbers.length < OPEN_PR_PAGE ? new Set(numbers) : undefined);
    } catch (err) {
      console.warn(`[run-retention] open PRs of ${repo} unreadable: ${(err as Error).message}`);
      open.set(repo, undefined);
    }
  }
  const activeSources = activeSourceHolds(runs, runs);
  return {
    now,
    ageMs: read.retentionDays() * DAY_MS,
    activeSource: (run) => activeSources.get(run.id),
    prState: (run): RunPrState => {
      const identity = identities.get(run.id);
      const lists = identity?.prs.map((pr) => open.get(pr.repo)?.has(pr.number)) ?? [];
      if (lists.includes(true)) return 'open';
      if (prRecordedSettled(run)) return 'settled';
      if (!identity) return 'none';
      return identity.unresolved || lists.includes(undefined) ? 'unknown' : 'settled';
    },
  };
}

/**
 * Runs that unsettled runs among `live` still read, with why: a follow-up inherits task
 * artifacts from its run family (`getFamilyRuns` over `members`), and an in-flight review reads
 * the prior run its repeat-review context recorded.
 */
export function activeSourceHolds(live: readonly Run[], members: Run[]): Map<string, string> {
  const holds = new Map<string, string>();
  for (const run of live) {
    if (runIsSettled(run)) continue;
    if (run.parentRunId && isFollowUpFlow(run.flowType)) {
      const { parentRun, rootRun, otherFamilyRuns } = getFamilyRuns(run, members);
      for (const source of [parentRun, rootRun, ...otherFamilyRuns])
        if (source && source.id !== run.id)
          holds.set(source.id, 'inherited by an unsettled follow-up');
    }
    if (run.flowType === 'review-pr')
      for (const prior of [
        run.repeatReviewContext?.priorRunId,
        run.repeatReviewContext?.session?.priorRunId,
      ])
        if (prior && !holds.has(prior)) holds.set(prior, 'prior of an in-flight review');
  }
  return holds;
}

/**
 * The hold right before a candidate moves: the pass's context, plus what runs dispatched since
 * the pass started now read.
 */
function currentRetentionHold(run: Run, context: RunRetentionContext): string | undefined {
  return (
    runRetentionHold(run, context) ??
    activeSourceHolds(getAllRuns(), [run, ...getAllRuns()]).get(run.id)
  );
}

export async function runHoldsSlot(run: Run): Promise<boolean> {
  return Boolean(run.slotId) && ownsRunSlotCleanup(await readSlotRow(run.slotId!), run.id);
}

export interface RunRetentionDeps {
  holdsSlot: (run: Run) => Promise<boolean>;
  openPrs: (repo: string) => Promise<number[]>;
  projectRepo: (project: string) => Promise<string | undefined>;
  /** Days a settled run keeps its storage. */
  retentionDays: () => number;
  withBundleLock: <T>(operation: () => Promise<T>) => Promise<T>;
}

export const RUN_RETENTION_DEPS: RunRetentionDeps = {
  holdsSlot: runHoldsSlot,
  openPrs: readOpenPrs,
  projectRepo,
  retentionDays: () => runBundleRetentionSettings(runBundleHome()).runRetentionDays,
  // Each eligible run's walk and stage is one turn under the lock; waiters allow a turn an hour.
  withBundleLock: async (operation) =>
    withRunBundleStoreLock(await runBundleStore(), operation, {
      label: 'run retention pass',
      holdLimitMs: 60 * 60_000,
    }),
};

/** Archive irreplaceable storage and delete recreatable copies only for eligible runs. Live and archived run records stay in place forever. */
export async function runRetentionPass(
  options: { apply: boolean; emit?: Emit; now?: number; roots?: RunRetentionRoots },
  deps: RunRetentionDeps = RUN_RETENTION_DEPS,
): Promise<RunRetentionPlan> {
  if (options.apply && !options.roots) {
    // ADR-039 Amendment 4: capture episodes a run end missed. First and independent of
    // archival, so an unavailable archive root never stops it.
    const loadedAt = Date.now();
    await captureMissingRunEpisodes(await getAllRunsWithArchived(), loadedAt).catch((error) =>
      console.error(`[run-episode] retry pass failed: ${(error as Error).message}`),
    );
  }
  const roots = options.roots ?? (await gatewayRetentionRoots());
  if (options.apply) {
    if (!options.roots) await warnRunBundleCapacity();
    await assertArchiveRoot(roots.archiveRoot);
    await resumeStorageArchives(roots.archiveRoot);
    if (!options.roots) {
      await archiveRunArtifactHousekeeping();
    }
  }
  const runs = await getAllRunsWithArchived();
  const context = await retentionContext(runs, options.now, deps);
  const { plan, removable } = await planRunRetention(runs, context, roots, deps.holdsSlot);
  if (!options.apply) return plan;
  const stagedRuns: {
    id: string;
    files: { source: string; store: RunRetentionStore; bytes: number }[];
  }[] = [];
  const stores = Object.fromEntries(
    Object.keys(plan.stores).map((store) => [store, { entries: 0, bytes: 0 }]),
  ) as RunRetentionPlan['stores'];
  const paths: RunRetentionPlan['paths'] = {
    'session-archives': [],
    'task-dirs': [],
    'task-pins': [],
    'review-workspaces': [],
    'native-sessions': [],
    'run-bundles': [],
  };
  // One lock turn per run, so admission and captures interleave with a long pass (F322).
  const turn = (operation: () => Promise<void>) =>
    deps.withBundleLock(() =>
      reclaimReviewWorkspaceStorage(async () => {
        await operation();
        return [];
      }),
    );
  await turn(async () => {
    // Preserve an old interrupted deletion pass, including its restore metadata, instead of purging it.
    const trash = path.join(roots.runsDir, 'retention-trash');
    if (existsSync(trash))
      await stageStoragePaths(roots.archiveRoot, 'legacy-retention-trash', [
        { source: trash, store: 'retention-trash' },
      ]);
  });
  const removableIds = new Set(removable.map((run) => run.id));
  for (const run of runs) {
    if (removableIds.has(run.id)) continue;
    await turn(() =>
      keepStorageDeletions(
        roots.archiveRoot,
        run.id,
        runRetentionHold(run, context) ?? 'holds its slot',
      ),
    );
  }
  const processed = new Set<string>();
  for (const candidate of removable) {
    await turn(async () => {
      try {
        if (await deps.holdsSlot(candidate)) {
          await keepStorageDeletions(roots.archiveRoot, candidate.id, 'holds its slot');
          return;
        }
        const run = await getRunWithArchived(candidate.id);
        const hold = run ? currentRetentionHold(run, context) : 'run missing';
        if (!run || hold) {
          await keepStorageDeletions(roots.archiveRoot, candidate.id, hold ?? 'run missing');
          return;
        }
        const others = [...runs, ...getAllRuns()].filter(
          (other) =>
            other.id !== run.id &&
            (!processed.has(other.id) || Boolean(runRetentionHold(other, context))),
        );
        const owned = runOwnedPaths([run], others, roots);
        const files: { source: string; store: RunRetentionStore; bytes: number }[] = [];
        for (const store of Object.keys(owned) as (keyof typeof owned)[])
          for (const source of owned[store]) {
            if (!existsSync(source) || (store === 'task-dirs' && isTaskDirectoryAdmitting(source)))
              continue;
            files.push({ source, store, bytes: await diskBytes(source) });
          }
        const pins = await retiredTaskPins(
          roots.taskPins,
          new Set(files.filter((file) => file.store === 'task-dirs').map((file) => file.source)),
          context,
          new Set(others.flatMap(runTaskDirectories)),
        );
        for (const source of pins)
          files.push({ source, store: 'task-pins', bytes: await diskBytes(source) });
        const deleteFiles: StorageDeletion[] = files.flatMap((file) =>
          file.store === 'task-pins' || file.store === 'review-workspaces'
            ? [
                {
                  ...file,
                  store: file.store,
                  root: file.store === 'task-pins' ? roots.taskPins : roots.reviewWorkspaces,
                },
              ]
            : [],
        );
        await keepStorageDeletions(
          roots.archiveRoot,
          run.id,
          'ownership or admission changed',
          deleteFiles,
        );
        if (!files.length) {
          processed.add(run.id);
          return;
        }
        await recordRunStorageArchive(run.id, storageArchiveManifest(roots.archiveRoot, run.id));
        await getRunWithArchived(run.id); // Reload after the durable link invalidates archived cache.
        const archiveFiles = files.filter(
          (file) => retentionStoreAction(file.store) === 'archived',
        );
        await stageStoragePaths(
          roots.archiveRoot,
          run.id,
          archiveFiles,
          () => {
            const latest = getCachedRunWithArchived(run.id);
            if (!latest || currentRetentionHold(latest, context)) return false;
            const current = [...runs, ...getAllRuns()].filter(
              (other) =>
                other.id !== run.id &&
                (!processed.has(other.id) || Boolean(runRetentionHold(other, context))),
            );
            const eligible = runOwnedPaths([run], current, roots);
            return files.every((file) => {
              if (file.store === 'task-pins') {
                const provenance: { taskDir?: unknown } = JSON.parse(
                  readFileSync(path.join(file.source, 'provenance.json'), 'utf8'),
                );
                const taskDir = provenance.taskDir;
                if (typeof taskDir !== 'string' || isTaskDirectoryAdmitting(taskDir)) return false;
                if (
                  current.some((other) => runTaskDirectories(other).includes(path.resolve(taskDir)))
                )
                  return false;
                return (
                  !existsSync(taskDir) ||
                  files.some(
                    (entry) =>
                      entry.store === 'task-dirs' && entry.source === path.resolve(taskDir),
                  )
                );
              }
              return (
                eligible[file.store].includes(file.source) &&
                (file.store !== 'task-dirs' || !isTaskDirectoryAdmitting(file.source))
              );
            });
          },
          deleteFiles,
        );
        processed.add(run.id);
        stagedRuns.push({ id: run.id, files });
      } catch (error) {
        console.error(
          `[run-retention] skipped ${candidate.id}; source/journal retained: ${(error as Error).message}`,
        );
      }
    });
  }
  // Hash, cross-volume copy and fsync happen after both admission locks are released.
  const failed = new Set(await resumeStorageArchives(roots.archiveRoot));
  const archived = [];
  for (const staged of stagedRuns) {
    if (failed.has(staged.id)) continue;
    archived.push(staged.id);
    for (const file of staged.files) {
      paths[file.store].push(file.source);
      stores[file.store].entries++;
      stores[file.store].bytes += file.bytes;
    }
  }
  return { runs: archived, held: plan.held, paths, stores };
}

export function formatRunRetention(plan: RunRetentionPlan): string {
  const stores = Object.entries(plan.stores)
    .map(
      ([store, { entries, bytes }]) =>
        `${store} ${retentionStoreAction(store)} ${entries} (${(bytes / 1e9).toFixed(2)} GB)`,
    )
    .join(', ');
  return `${plan.runs.length} run(s): ${stores}`;
}

/** The gateway itself checks its archive access, including removable-volume privacy, before every pass. */
export function startRunRetention(emit: Emit): void {
  if (process.env.FARMSLOT_SANDBOX_HOME) return;
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    runRetentionPass({ apply: true, emit })
      .then(async (plan) => {
        await parkedWorkRetentionPass();
        if (plan.runs.length) console.log(`[run-retention] ${formatRunRetention(plan)}`);
      })
      .catch((err) =>
        console.error(
          `[run-retention] ARCHIVE FAILED; source storage retained: ${(err as Error).stack}`,
        ),
      )
      .finally(() => {
        running = false;
      });
  };
  assertArchiveRoot(runArchiveRoot())
    .then(() => console.log(`[run-retention] gateway archive root writable: ${runArchiveRoot()}`))
    .catch((err) =>
      console.error(`[run-retention] ARCHIVE ROOT UNAVAILABLE: ${(err as Error).stack}`),
    );
  setTimeout(pass, RUN_RETENTION_FIRST_PASS_MS).unref();
  setInterval(pass, RUN_RETENTION_INTERVAL_MS).unref();
}
