import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Events, type Run } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { projectTaskRoots } from '../../core/config.js';
import { ownsRunSlotCleanup, readSlotRow } from '../../core/index.js';
import { loadProjectConfig } from '../../fleet/state.js';
import { ghRequest } from '../../integrations/github-client.js';
import { reclaimReviewWorkspaceStorage } from '../../review-workspaces/storage-use.js';
import {
  collectRunArtifactGarbage,
  runBundleStore,
} from '../../run-completion/retained-artifacts.js';
import { nativeSessionManager } from '../../runners/native/manager.js';
import {
  diskBytes,
  measureRetention,
  planRunRetention,
  retiredTaskPins,
  runOwnedPaths,
  runPrUnsettled,
  type RunRetentionContext,
  runRetentionHold,
  type RunRetentionPlan,
  type RunRetentionRoots,
} from '../../runs/retention.js';
import {
  deleteArchivedRun,
  deleteRun,
  getAllRunsWithArchived,
  getRun,
  getRunWithArchived,
  runsDirectory,
  runSessionArchiveDir,
} from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

const RUN_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
// Record and session-archive deletion belongs to the run store; bundles to the bundle store.
const FILE_STORES = ['task-dirs', 'task-pins', 'review-workspaces', 'native-sessions'] as const;

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

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const OPEN_PR_PAGE = 1000;

/**
 * Whether each run's PR is open now. Each repo's open PRs are read once per pass;
 * a repo that cannot be read, or whose list may be truncated, leaves its runs unknown.
 */
export async function retentionContext(
  runs: Run[],
  now = Date.now(),
): Promise<RunRetentionContext> {
  const prs = new Map<string, { repo: string; number: number }>();
  const projectRepos = new Map<string, string | undefined>();
  for (const run of runs) {
    if (!runPrUnsettled(run)) continue;
    const link = run.links
      ?.map((l) => (l.label === 'PR' ? PR_URL.exec(l.url) : null))
      .find(Boolean);
    if (link) {
      prs.set(run.id, { repo: link[1], number: Number(link[2]) });
      continue;
    }
    if (run.prNumber === undefined || !run.project) continue;
    if (!projectRepos.has(run.project))
      projectRepos.set(run.project, (await loadProjectConfig(run.project))?.ci?.repo);
    const repo = projectRepos.get(run.project);
    if (repo) prs.set(run.id, { repo, number: run.prNumber });
  }
  const open = new Map<string, Set<number> | undefined>();
  for (const repo of new Set([...prs.values()].map((pr) => pr.repo))) {
    try {
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
      const numbers = stdout.split('\n').filter(Boolean).map(Number);
      open.set(repo, numbers.length < OPEN_PR_PAGE ? new Set(numbers) : undefined);
    } catch (err) {
      console.warn(`[run-retention] open PRs of ${repo} unreadable: ${(err as Error).message}`);
      open.set(repo, undefined);
    }
  }
  return {
    now,
    prOpen: (run) => {
      const pr = prs.get(run.id);
      return pr && open.get(pr.repo)?.has(pr.number);
    },
  };
}

export async function runHoldsSlot(run: Run): Promise<boolean> {
  return Boolean(run.slotId) && ownsRunSlotCleanup(await readSlotRow(run.slotId!), run.id);
}

/** Recheck at deletion time: the run may have changed since the plan was made. */
async function deleteRetiredRun(id: string, context: RunRetentionContext): Promise<boolean> {
  const run = await getRunWithArchived(id);
  if (!run || runRetentionHold(run, context) || (await runHoldsSlot(run))) return false;
  if (getRun(id) && !(await deleteRun(id))) return false;
  await deleteArchivedRun(id);
  return true;
}

/**
 * Remove done, cancelled and archived runs settled for 48 h, with the storage only they
 * own (ADR-039 Amendment 2). A dry run returns the same plan without changing anything.
 */
export async function runRetentionPass(options: {
  apply: boolean;
  emit?: Emit;
  now?: number;
  roots?: RunRetentionRoots;
}): Promise<RunRetentionPlan> {
  const roots = options.roots ?? (await gatewayRetentionRoots());
  const runs = await getAllRunsWithArchived();
  const context = await retentionContext(runs, options.now);
  const { now } = context;
  const { plan, removable } = await planRunRetention(runs, context, roots, runHoldsSlot);
  if (!options.apply || !removable.length) return plan;
  let removed: RunRetentionPlan | undefined;
  // Holding review-workspace reclamation keeps new workspace admissions out while files go.
  await reclaimReviewWorkspaceStorage(async () => {
    const deleted: Run[] = [];
    const records = { entries: 0, bytes: 0 };
    const sessions = { entries: 0, bytes: 0 };
    for (const run of removable) {
      const recordBytes =
        (await diskBytes(path.join(roots.runsDir, `${run.id}.json`))) +
        (await diskBytes(path.join(roots.runsDir, 'archive', `${run.id}.json`)));
      const sessionBytes = await diskBytes(roots.sessionArchive(run.id));
      try {
        if (!(await deleteRetiredRun(run.id, context))) continue;
      } catch (err) {
        console.warn(
          `[run-retention] kept ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      deleted.push(run);
      records.entries++;
      records.bytes += recordBytes;
      if (sessionBytes) {
        sessions.entries++;
        sessions.bytes += sessionBytes;
      }
      options.emit?.(Events.RUN_DELETED, { runId: run.id });
    }
    // Storage goes only when no remaining run references it.
    const owned = runOwnedPaths(deleted, await getAllRunsWithArchived(), roots);
    removed = await measureRetention(deleted, plan.held, {
      ...owned,
      'run-records': [],
      'session-archives': [],
      'task-pins': await retiredTaskPins(roots.taskPins, new Set(owned['task-dirs']), now),
    });
    removed.stores['run-records'] = records;
    removed.stores['session-archives'] = sessions;
    for (const store of FILE_STORES)
      for (const file of removed.paths[store]) await rm(file, { recursive: true, force: true });
    return [];
  });
  // Unreferenced bundles leave through the bundle store's own collector.
  if (removed?.runs.length) await collectRunArtifactGarbage();
  return removed ?? { ...plan, runs: [] };
}

export function formatRunRetention(plan: RunRetentionPlan): string {
  const stores = Object.entries(plan.stores)
    .map(([store, { entries, bytes }]) => `${store} ${entries} (${(bytes / 1e9).toFixed(2)} GB)`)
    .join(', ');
  return `${plan.runs.length} run(s): ${stores}`;
}

/** The engine's hourly retention pass. Sandbox gateways do not own the stores. */
export function startRunRetention(emit: Emit): void {
  if (process.env.FARMSLOT_SANDBOX_HOME) return;
  let running = false;
  setInterval(() => {
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
  }, RUN_RETENTION_INTERVAL_MS).unref();
}
