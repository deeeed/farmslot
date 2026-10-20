import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
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
  isTaskDirectoryAdmitting,
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
  /** Synchronous, so a recheck and the moves it allows happen in one step. */
  move: (from: string, to: string) => void;
}

export const RUN_RETENTION_DEPS: RunRetentionDeps = {
  deleteRecord: deleteRunRecord,
  // Deleting a settled run closes its backlog link without requeueing the item, as archiving
  // a blocked run does.
  // Loaded on use: admin's slot code configures tmux on import, which a dry run must not do.
  releaseBacklogLink: async (id) =>
    (await import('./admin.js')).reconcileDeletedRun(id, { keepNeedsAttention: true }),
  collectGarbage: collectRunArtifactGarbage,
  holdsSlot: runHoldsSlot,
  openPrs: readOpenPrs,
  projectRepo,
  move: renameSync,
};

type StagedStore = (typeof STAGED_STORES)[number];
interface TrashRecord {
  runId: string;
  store: StagedStore;
  path: string;
}

/**
 * Record where `file` came from, then move it into the trash. Across volumes it stays
 * put: only a move can be undone if the record is not deleted.
 */
function stage(
  trash: string,
  record: TrashRecord,
  move: RunRetentionDeps['move'],
): string | 'absent' | 'cross-volume' {
  const target = path.join(trash, randomUUID());
  try {
    writeFileSync(`${target}.json`, JSON.stringify(record));
  } catch (err) {
    rmSync(`${target}.json`, { force: true });
    throw err;
  }
  try {
    move(record.path, target);
    return target;
  } catch (err) {
    rmSync(`${target}.json`, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    if (code === 'EXDEV') return 'cross-volume';
    throw err;
  }
}

/** Put a staged directory back; one that cannot go back stays for the next pass to retry. */
function unstage(entry: string, record: TrashRecord, move: RunRetentionDeps['move']): void {
  try {
    move(entry, record.path);
    rmSync(`${entry}.json`, { force: true });
  } catch (err) {
    console.warn(`[run-retention] could not restore ${record.path}: ${(err as Error).message}`);
  }
}

/** Remove trash entries and their records; returns the bytes freed. */
async function purge(entries: string[]): Promise<number> {
  let bytes = 0;
  for (const entry of entries)
    try {
      const size = await diskBytes(entry);
      await rm(entry, { recursive: true, force: true });
      await rm(`${entry}.json`, { force: true });
      bytes += size;
    } catch (err) {
      console.warn(`[run-retention] could not remove ${entry}: ${(err as Error).message}`);
    }
  return bytes;
}

/** The trash's recorded entries; an entry with no record is left alone and reported. */
async function trashRecords(trash: string): Promise<{ entry: string; record?: TrashRecord }[]> {
  let names: string[];
  try {
    names = await readdir(trash);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  for (const name of names)
    if (!name.endsWith('.json') && !names.includes(`${name}.json`))
      console.warn(`[run-retention] ${path.join(trash, name)} has no record; left in place`);
  const records: { entry: string; record?: TrashRecord }[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const entry = path.join(trash, name.slice(0, -'.json'.length));
    try {
      records.push({ entry, record: JSON.parse(await readFile(`${entry}.json`, 'utf8')) });
    } catch (err) {
      console.warn(`[run-retention] unreadable record for ${entry}: ${(err as Error).message}`);
      records.push({ entry });
    }
  }
  return records;
}

/**
 * Finish what an interrupted pass left in the trash: a directory whose run still exists
 * goes back, since that run was never deleted; one whose run is gone is purged.
 */
async function recoverTrash(trash: string, move: RunRetentionDeps['move']): Promise<void> {
  for (const { entry, record } of await trashRecords(trash)) {
    if (!record) continue;
    try {
      if (!existsSync(entry)) await rm(`${entry}.json`, { force: true });
      else if (await getRunWithArchived(record.runId)) unstage(entry, record, move);
      else await purge([entry]);
    } catch (err) {
      console.warn(`[run-retention] could not recover ${entry}: ${(err as Error).message}`);
    }
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
  if (options.apply) await recoverTrash(trash, deps.move);
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
  const staged: { store: StagedStore; entry: string }[] = [];
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
        // No await from this recheck until the moves: a run registered or archived since the
        // plan is in one of these lists, and a run being admitted holds its task directory.
        if (!run || runRetentionHold(run, context)) continue;
        const others = [...runs, ...getAllRuns()].filter((r) => r.id !== run.id && !gone.has(r.id));
        const owned = runOwnedPaths([run], others, roots);
        const moved: { store: StagedStore; entry: string; record: TrashRecord }[] = [];
        let movable = true;
        try {
          const files = STAGED_STORES.flatMap((store) =>
            owned[store]
              .filter((file) => store !== 'task-dirs' || !isTaskDirectoryAdmitting(file))
              .map((file) => ({ runId: run.id, store, path: file })),
          );
          for (const record of files) {
            const entry = stage(trash, record, deps.move);
            if (entry === 'cross-volume') {
              movable = false;
              break;
            }
            if (entry !== 'absent') moved.push({ store: record.store, entry, record });
          }
        } catch (err) {
          movable = false;
          console.warn(
            `[run-retention] could not move ${run.id}'s storage: ${(err as Error).message}`,
          );
        }
        let ok = false;
        if (movable)
          try {
            ok = await deps.deleteRecord(run.id);
          } catch (err) {
            console.warn(`[run-retention] kept ${run.id}: ${(err as Error).message}`);
          }
        if (!ok) {
          for (const { entry, record } of moved) unstage(entry, record, deps.move);
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
        for (const { store, entry, record } of moved) {
          paths[store].push(record.path);
          staged.push({ store, entry });
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
  for (const { store, entry } of staged) {
    stores[store].entries++;
    stores[store].bytes += await purge([entry]);
  }
  // A task directory still recorded in the trash (a restore that failed) is not gone.
  const pending = (await trashRecords(trash)).flatMap(({ record }) =>
    record?.store === 'task-dirs' ? [record.path] : [],
  );
  const pins = await retiredTaskPins(
    roots.taskPins,
    new Set(paths['task-dirs']),
    context.now,
    new Set(pending),
  );
  for (const pin of pins) {
    const bytes = await diskBytes(pin);
    try {
      await rm(pin, { recursive: true, force: true });
      stores['task-pins'].entries++;
      stores['task-pins'].bytes += bytes;
      paths['task-pins'].push(pin);
    } catch (err) {
      console.warn(`[run-retention] could not remove ${pin}: ${(err as Error).message}`);
    }
  }
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
