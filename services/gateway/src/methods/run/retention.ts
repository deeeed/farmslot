import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { withRunBundleStoreLock } from '@farmslot/run-bundle';

import { projectTaskRoots } from '../../core/config.js';
import { ownsRunSlotCleanup, readSlotRow } from '../../core/index.js';
import { loadProjectConfig } from '../../fleet/state.js';
import { ghRequest } from '../../integrations/github-client.js';
import { reviewPRIdentity } from '../../review/session-mode.js';
import { reclaimReviewWorkspaceStorage } from '../../review-workspaces/storage-use.js';
import {
  archiveRunArtifactHousekeeping,
  runBundleStore,
  warnRunBundleCapacity,
} from '../../run-completion/retained-artifacts.js';
import { captureMissingRunEpisodes } from '../../run-completion/run-episode.js';
import { nativeSessionManager } from '../../runners/native/manager.js';
import {
  diskBytes,
  planRunRetention,
  retiredTaskPins,
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
  resumeStorageArchives,
  runArchiveRoot,
  stageStoragePaths,
  storageArchiveManifest,
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
    taskPins: path.resolve(farmslotHome(), 'task-pins'),
    nativeSessions: nativeSessionManager.root,
    reviewWorkspaces: path.join(path.dirname(nativeSessionManager.root), 'review-workspaces'),
    bundles: { id: store.id, root: store.root },
  };
}

async function readOpenPrs(repo: string): Promise<number[]> {
  const { stdout } = await ghRequest(
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      String(OPEN_PR_PAGE),
      '--json',
      'number',
      '--jq',
      '.[].number',
    ],
    { caller: 'run-retention' },
  );
  return stdout.split('\n').filter(Boolean).map(Number);
}

async function projectRepo(project: string): Promise<string | undefined> {
  return (await loadProjectConfig(project))?.ci?.repo;
}

const prRecordedSettled = (run: Run) =>
  Boolean(run.mergedAt) || run.prState === 'MERGED' || run.prState === 'CLOSED';

/**
 * Each run's PR state for this pass. A PR the run records as merged or closed is settled.
 * Otherwise every identity it has (the review-session identity, and its own number in the
 * project's repository) is checked against that repository's open PRs, read once. Any
 * open PR keeps the run; so does an unresolvable identity, an unreadable repository or a
 * possibly truncated list.
 */
export async function retentionContext(
  runs: Run[],
  now = Date.now(),
  read: Pick<RunRetentionDeps, 'openPrs' | 'projectRepo'> = { openPrs: readOpenPrs, projectRepo },
): Promise<RunRetentionContext> {
  const identities = new Map<
    string,
    { prs: { repo: string; number: number }[]; unresolved: boolean }
  >();
  const projectRepos = new Map<string, string | undefined>();
  for (const run of runs) {
    if (prRecordedSettled(run)) continue;
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
  return {
    now,
    prState: (run): RunPrState => {
      if (prRecordedSettled(run)) return 'settled';
      const identity = identities.get(run.id);
      if (!identity) return 'none';
      const lists = identity.prs.map((pr) => open.get(pr.repo)?.has(pr.number));
      if (lists.includes(true)) return 'open';
      return identity.unresolved || lists.includes(undefined) ? 'unknown' : 'settled';
    },
  };
}

export async function runHoldsSlot(run: Run): Promise<boolean> {
  return Boolean(run.slotId) && ownsRunSlotCleanup(await readSlotRow(run.slotId!), run.id);
}

export interface RunRetentionDeps {
  holdsSlot: (run: Run) => Promise<boolean>;
  openPrs: (repo: string) => Promise<number[]>;
  projectRepo: (project: string) => Promise<string | undefined>;
  withBundleLock: <T>(operation: () => Promise<T>) => Promise<T>;
}

export const RUN_RETENTION_DEPS: RunRetentionDeps = {
  holdsSlot: runHoldsSlot,
  openPrs: readOpenPrs,
  projectRepo,
  // The pass walks every eligible run's storage under the lock; waiters allow it an hour.
  withBundleLock: async (operation) =>
    withRunBundleStoreLock(await runBundleStore(), operation, {
      label: 'run retention pass',
      holdLimitMs: 60 * 60_000,
    }),
};

/** Archive only eligible run-owned storage. Live and archived run records stay in place forever. */
export async function runRetentionPass(
  options: { apply: boolean; emit?: Emit; now?: number; roots?: RunRetentionRoots },
  deps: RunRetentionDeps = RUN_RETENTION_DEPS,
): Promise<RunRetentionPlan> {
  const roots = options.roots ?? (await gatewayRetentionRoots());
  if (options.apply) {
    await assertArchiveRoot(roots.archiveRoot);
    if (!options.roots) {
      await archiveRunArtifactHousekeeping();
      await warnRunBundleCapacity();
    }
  }
  const runs = await getAllRunsWithArchived();
  if (options.apply && !options.roots) {
    // ADR-039 Amendment 4: capture episodes the run-end effect missed; never blocks archival.
    await captureMissingRunEpisodes(runs).catch((error) =>
      console.error(`[run-episode] retry pass failed: ${(error as Error).message}`),
    );
  }
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
  await deps.withBundleLock(() =>
    reclaimReviewWorkspaceStorage(async () => {
      // Preserve an old interrupted deletion pass, including its restore metadata, instead of purging it.
      const trash = path.join(roots.runsDir, 'retention-trash');
      if (existsSync(trash))
        await stageStoragePaths(roots.archiveRoot, 'legacy-retention-trash', [
          { source: trash, store: 'retention-trash' },
        ]);
      const processed = new Set<string>();
      for (const candidate of removable) {
        try {
          if (await deps.holdsSlot(candidate)) continue;
          const run = await getRunWithArchived(candidate.id);
          if (!run || runRetentionHold(run, context)) continue;
          const others = [...runs, ...getAllRuns()].filter(
            (other) =>
              other.id !== run.id &&
              (!processed.has(other.id) || Boolean(runRetentionHold(other, context))),
          );
          const owned = runOwnedPaths([run], others, roots);
          const files: { source: string; store: RunRetentionStore; bytes: number }[] = [];
          for (const store of Object.keys(owned) as (keyof typeof owned)[])
            for (const source of owned[store]) {
              if (
                !existsSync(source) ||
                (store === 'task-dirs' && isTaskDirectoryAdmitting(source))
              )
                continue;
              files.push({ source, store, bytes: await diskBytes(source) });
            }
          const pins = await retiredTaskPins(
            roots.taskPins,
            new Set(files.filter((file) => file.store === 'task-dirs').map((file) => file.source)),
            context.now,
          );
          for (const source of pins)
            files.push({ source, store: 'task-pins', bytes: await diskBytes(source) });
          if (!files.length) {
            processed.add(run.id);
            continue;
          }
          await recordRunStorageArchive(run.id, storageArchiveManifest(roots.archiveRoot, run.id));
          await getRunWithArchived(run.id); // Reload after the durable link invalidates archived cache.
          await stageStoragePaths(roots.archiveRoot, run.id, files, () => {
            const latest = getCachedRunWithArchived(run.id);
            if (!latest || runRetentionHold(latest, context)) return false;
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
          });
          processed.add(run.id);
          stagedRuns.push({ id: run.id, files });
        } catch (error) {
          console.error(
            `[run-retention] skipped ${candidate.id}; source/journal retained: ${(error as Error).message}`,
          );
        }
      }
      return [];
    }),
  );
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
    .map(([store, { entries, bytes }]) => `${store} ${entries} (${(bytes / 1e9).toFixed(2)} GB)`)
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
      .then((plan) => {
        if (plan.runs.length) console.log(`[run-retention] archived ${formatRunRetention(plan)}`);
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
