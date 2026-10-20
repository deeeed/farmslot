import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Events, type Run } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { projectTaskRoots } from '../../core/config.js';
import { ownsRunSlotCleanup, readSlotRow } from '../../core/index.js';
import { loadProjectConfig } from '../../fleet/state.js';
import { ghRequest } from '../../integrations/github-client.js';
import { reviewPRIdentity } from '../../review/session-mode.js';
import { reclaimReviewWorkspaceStorage } from '../../review-workspaces/storage-use.js';
import {
  collectRunArtifactGarbage,
  runBundleStore,
} from '../../run-completion/retained-artifacts.js';
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
  deleteArchivedRun,
  deleteRun,
  getAllRuns,
  getAllRunsWithArchived,
  getRun,
  getRunWithArchived,
  runsDirectory,
  runSessionArchiveDir,
} from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

const RUN_RETENTION_FIRST_PASS_MS = 10 * 60 * 1000;
const RUN_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const OPEN_PR_PAGE = 1000;
// Directories a run owns outside the run store; the store deletes records and session archives.
const STAGED_STORES = ['task-dirs', 'review-workspaces', 'native-sessions'] as const;

export async function gatewayRetentionRoots(): Promise<RunRetentionRoots> {
  const store = await runBundleStore();
  return {
    runsDir: runsDirectory(),
    sessionArchive: runSessionArchiveDir,
    taskRoots: [
      ...(await projectTaskRoots()).map(({ root }) => root),
      path.join(runsDirectory(), 'review-workspace-tasks'),
    ],
    // @farmslot/agent-runtime's task producer writes pins here.
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
 * Otherwise its repository's open PRs are read once; an unresolvable identity, an
 * unreadable repository or a possibly truncated list leaves the run `unknown`.
 */
export async function retentionContext(
  runs: Run[],
  now = Date.now(),
  read: Pick<RunRetentionDeps, 'openPrs' | 'projectRepo'> = { openPrs: readOpenPrs, projectRepo },
): Promise<RunRetentionContext> {
  const identities = new Map<string, { repo: string; number: number } | undefined>();
  const projectRepos = new Map<string, string | undefined>();
  for (const run of runs) {
    if (prRecordedSettled(run)) continue;
    const pr = reviewPRIdentity(run);
    if (pr) {
      identities.set(run.id, { repo: pr.repository, number: pr.prNumber });
      continue;
    }
    const linked = run.links?.some((link) => link.label.toLowerCase() === 'pr');
    if (run.prNumber === undefined && !linked) continue;
    let repo: string | undefined;
    if (run.prNumber !== undefined && run.project) {
      if (!projectRepos.has(run.project))
        projectRepos.set(run.project, await read.projectRepo(run.project));
      repo = projectRepos.get(run.project);
    }
    identities.set(run.id, repo ? { repo, number: run.prNumber! } : undefined);
  }
  const open = new Map<string, Set<number> | undefined>();
  for (const repo of new Set([...identities.values()].flatMap((pr) => (pr ? [pr.repo] : [])))) {
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
      if (!identities.has(run.id)) return 'none';
      const pr = identities.get(run.id);
      const numbers = pr && open.get(pr.repo);
      if (!pr || !numbers) return 'unknown';
      return numbers.has(pr.number) ? 'open' : 'settled';
    },
  };
}

export async function runHoldsSlot(run: Run): Promise<boolean> {
  return Boolean(run.slotId) && ownsRunSlotCleanup(await readSlotRow(run.slotId!), run.id);
}

async function deleteRunRecord(id: string): Promise<boolean> {
  if (getRun(id) && !(await deleteRun(id))) return false;
  await deleteArchivedRun(id);
  return true;
}

export interface RunRetentionDeps {
  deleteRecord: (id: string) => Promise<boolean>;
  releaseBacklogLink: (id: string) => Promise<void>;
  collectGarbage: () => Promise<void>;
  holdsSlot: (run: Run) => Promise<boolean>;
  openPrs: (repo: string) => Promise<number[]>;
  projectRepo: (project: string) => Promise<string | undefined>;
}

export const RUN_RETENTION_DEPS: RunRetentionDeps = {
  deleteRecord: deleteRunRecord,
  // Deleting a settled run closes its backlog link; like archive, it must not requeue the item.
  // Loaded on use: admin's slot code configures tmux on import, which a dry run must not do.
  releaseBacklogLink: async (id) =>
    (await import('./admin.js')).reconcileDeletedRun(id, { keepNeedsAttention: true }),
  collectGarbage: collectRunArtifactGarbage,
  holdsSlot: runHoldsSlot,
  openPrs: readOpenPrs,
  projectRepo,
};

/** Move a path into the trash in one synchronous step; across volumes, delete it in place. */
function stage(file: string, trash: string): string | undefined {
  const target = path.join(trash, randomUUID());
  try {
    renameSync(file, target);
    return target;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code !== 'EXDEV') throw err;
    rmSync(file, { recursive: true, force: true });
    return undefined;
  }
}

async function removeAll(files: string[]): Promise<number> {
  let bytes = 0;
  for (const file of files)
    try {
      const size = await diskBytes(file);
      await rm(file, { recursive: true, force: true });
      bytes += size;
    } catch (err) {
      console.warn(`[run-retention] could not remove ${file}: ${(err as Error).message}`);
    }
  return bytes;
}

/** Empty the trash, including anything an interrupted pass left there. */
async function emptyTrash(trash: string): Promise<void> {
  try {
    await removeAll((await readdir(trash)).map((name) => path.join(trash, name)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Remove done, cancelled and archived runs settled for 48 h, with the storage only they
 * own (ADR-039 Amendment 2). A dry run returns the same plan without changing anything.
 */
export async function runRetentionPass(
  options: { apply: boolean; emit?: Emit; now?: number; roots?: RunRetentionRoots },
  deps: RunRetentionDeps = RUN_RETENTION_DEPS,
): Promise<RunRetentionPlan> {
  const roots = options.roots ?? (await gatewayRetentionRoots());
  const trash = path.join(roots.runsDir, 'retention-trash');
  if (options.apply) await emptyTrash(trash);
  const runs = await getAllRunsWithArchived();
  const context = await retentionContext(runs, options.now, deps);
  const { plan, removable } = await planRunRetention(runs, context, roots, deps.holdsSlot);
  if (!options.apply || !removable.length) return plan;

  const deleted: Run[] = [];
  const stores = {} as RunRetentionPlan['stores'];
  const paths = {} as RunRetentionPlan['paths'];
  for (const store of Object.keys(plan.stores) as RunRetentionStore[]) {
    stores[store] = { entries: 0, bytes: 0 };
    paths[store] = [];
  }
  const staged: string[] = [];
  let ran = false;
  // Review-workspace admissions wait while this pass moves workspace directories.
  await reclaimReviewWorkspaceStorage(async () => {
    ran = true;
    mkdirSync(trash, { recursive: true });
    const gone = new Set<string>();
    for (const candidate of removable) {
      try {
        const record = [
          path.join(roots.runsDir, `${candidate.id}.json`),
          path.join(roots.runsDir, 'archive', `${candidate.id}.json`),
        ];
        const recordBytes = (await diskBytes(record[0])) + (await diskBytes(record[1]));
        const sessionBytes = await diskBytes(roots.sessionArchive(candidate.id));
        if (await deps.holdsSlot(candidate)) continue;
        const run = await getRunWithArchived(candidate.id);
        // No await from this recheck until the moves: a run created or archived since the
        // plan is in one of these lists, so a directory it uses stays where it is.
        if (!run || runRetentionHold(run, context)) continue;
        const others = [...runs, ...getAllRuns()].filter((r) => r.id !== run.id && !gone.has(r.id));
        const owned = runOwnedPaths([run], others, roots);
        const moved = STAGED_STORES.flatMap((store) =>
          owned[store].flatMap((file) => {
            const to = stage(file, trash);
            return to ? [{ store, file, to }] : [];
          }),
        );
        let ok = false;
        try {
          ok = await deps.deleteRecord(run.id);
        } catch (err) {
          console.warn(`[run-retention] kept ${run.id}: ${(err as Error).message}`);
        }
        if (!ok) {
          for (const { file, to } of moved)
            try {
              renameSync(to, file);
            } catch (err) {
              console.warn(`[run-retention] could not restore ${file}: ${(err as Error).message}`);
            }
          continue;
        }
        gone.add(run.id);
        deleted.push(run);
        stores['run-records'].entries++;
        stores['run-records'].bytes += recordBytes;
        paths['run-records'].push(...record);
        if (sessionBytes) {
          stores['session-archives'].entries++;
          stores['session-archives'].bytes += sessionBytes;
          paths['session-archives'].push(roots.sessionArchive(run.id));
        }
        for (const { store, file, to } of moved) {
          stores[store].entries++;
          stores[store].bytes += await diskBytes(to);
          paths[store].push(file);
          staged.push(to);
        }
        await deps.releaseBacklogLink(run.id);
        options.emit?.(Events.RUN_DELETED, { runId: run.id });
      } catch (err) {
        console.warn(`[run-retention] skipped ${candidate.id}: ${(err as Error).message}`);
      }
    }
    return [];
  });
  if (!ran) {
    console.log('[run-retention] review workspaces are in use; the next pass retries');
    return { ...plan, runs: [] };
  }
  await removeAll(staged);
  const pins = await retiredTaskPins(roots.taskPins, new Set(paths['task-dirs']), context.now);
  stores['task-pins'] = { entries: pins.length, bytes: await removeAll(pins) };
  paths['task-pins'] = pins;
  // Bundles only the deleted runs referenced leave through the bundle store's collector.
  paths['run-bundles'] = runOwnedPaths(deleted, await getAllRunsWithArchived(), roots)[
    'run-bundles'
  ];
  for (const bundle of paths['run-bundles']) {
    stores['run-bundles'].entries++;
    stores['run-bundles'].bytes += await diskBytes(bundle);
  }
  if (deleted.length) await deps.collectGarbage();
  return { runs: deleted.map((run) => run.id), held: plan.held, paths, stores };
}

export function formatRunRetention(plan: RunRetentionPlan): string {
  const stores = Object.entries(plan.stores)
    .map(([store, { entries, bytes }]) => `${store} ${entries} (${(bytes / 1e9).toFixed(2)} GB)`)
    .join(', ');
  return `${plan.runs.length} run(s): ${stores}`;
}

/** The engine's retention pass, 10 min after start and then hourly; sandbox gateways skip it. */
export function startRunRetention(emit: Emit): void {
  if (process.env.FARMSLOT_SANDBOX_HOME) return;
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    runRetentionPass({ apply: true, emit })
      .then((plan) => {
        if (plan.runs.length) console.log(`[run-retention] removed ${formatRunRetention(plan)}`);
      })
      .catch((err) => console.warn(`[run-retention] pass failed: ${(err as Error).message}`))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(pass, RUN_RETENTION_FIRST_PASS_MS).unref();
  setInterval(pass, RUN_RETENTION_INTERVAL_MS).unref();
}
