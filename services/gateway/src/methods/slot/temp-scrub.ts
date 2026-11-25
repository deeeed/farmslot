import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_BRANCH,
  isSlotFreedByPark,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import { resolveProjectRuntimeDirName, resolveProjectTaskDirName } from '../../core/config.js';
import {
  execOnSlot,
  getProjectField,
  type RawProjectJson,
  readSlotRow,
  type SlotVars,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import {
  scrubSlotTemp,
  surveySlotTemp,
  type TempCheckout,
  type TempScrubResult,
} from '../../fleet/temp-scrub.js';
import { parkGitWork, readParkedGitWork } from '../../host-services/parked-work.js';
import { retainedRunTaskDirectory } from '../../run-completion/retained-artifacts.js';
import { workerTaskDirectory } from '../../run-engine/worker-task-dir.js';
import { persistSlotParkedInventory } from '../../run-lifecycle/validation-run-commits.js';
import { getRunWithArchived, listRunsForSlotHistory } from '../../runs/store.js';
import { slotPinIsRequestOnly } from '../dispatch/slot-scoring.js';

/** The layout this scrub owns: only there is everything in temp/ a run's or the farm's. */
export const TEMP_TASK_ROOT = 'temp/tasks';

/**
 * What a slot keeps in temp/ between runs: `temp/farmslot` (deps stamps and locks, CI parity),
 * the runtime dir, the recipe harness, the dirs of the project's watched resource files (dev
 * server and browser pid files and their profiles), the preflight pid and Spotlight's opt-out.
 * This is farm state; a pack that writes run output into it cleans that itself.
 */
export function tempStatePaths(projectJson: RawProjectJson): string[] {
  const runtime = resolveProjectRuntimeDirName(projectJson);
  const watched = Object.values(projectJson.resources ?? {}).flatMap((resource) => {
    const watchPath = resource.watch?.path?.replaceAll('{{runtime_dir}}', runtime);
    if (!watchPath) return [];
    const file = path.posix.normalize(watchPath);
    const dir = path.posix.dirname(file);
    // A pid file directly in temp/ keeps only itself.
    return [dir === 'temp' ? file : dir];
  });
  return [
    ...new Set(
      [
        'temp/farmslot',
        runtime,
        'temp/recipe/harness',
        ...watched,
        'temp/.agent/preflight.pid',
        'temp/.metadata_never_index',
      ].filter((entry) => entry.startsWith('temp/') && !entry.includes('..')),
    ),
  ];
}

/** A run's task dir on the slot, relative to the checkout (the worker keeps flow and folder). */
export function slotTaskRelDir(run: Pick<Run, 'taskFile'>, taskDirName: string): string | null {
  return run.taskFile
    ? workerTaskDirectory(run.taskFile, '', taskDirName).replace(/^\/+/, '')
    : null;
}

export type BundleCheck =
  | { confirmed: true; taskDir: string }
  | { confirmed: false; reason: string };

/**
 * Whether the run's final bundle holds this task: the final ref, a complete capture, a bundle
 * record naming the run's task folder, and `TASK.md` plus every recorded artifact in its copy.
 * Prepare only names what it removes with this; it decides nothing.
 */
export async function taskBundleCheck(run: Run): Promise<BundleCheck> {
  const ref = run.output?.artifactBundle;
  if (!isTerminalRunStatus(run.status)) return { confirmed: false, reason: 'run not finished' };
  if (!ref || !run.taskFile) return { confirmed: false, reason: 'no final bundle' };
  if (run.output?.captureError) return { confirmed: false, reason: 'capture failed' };
  if (run.output?.retentionMissingData?.length)
    return { confirmed: false, reason: 'capture incomplete' };
  const taskDir = await retainedRunTaskDirectory(run, ref);
  const manifest = path.join(path.dirname(path.dirname(taskDir)), 'manifest.json');
  const recorded: unknown = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8'))
    : null;
  const folder = path.posix.join(
    path.basename(path.dirname(path.dirname(run.taskFile))),
    path.basename(path.dirname(run.taskFile)),
  );
  const runs =
    recorded && typeof recorded === 'object' && 'runs' in recorded && Array.isArray(recorded.runs)
      ? recorded.runs
      : [];
  const entry: unknown = runs.find(
    (candidate: unknown) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'originalRunId' in candidate &&
      candidate.originalRunId === run.id,
  );
  const taskPath =
    entry && typeof entry === 'object' && 'taskRelativePath' in entry
      ? entry.taskRelativePath
      : undefined;
  if (typeof taskPath !== 'string' || (taskPath !== folder && !taskPath.endsWith(`/${folder}`)))
    return { confirmed: false, reason: 'bundle record names another task' };
  if (!existsSync(path.join(taskDir, 'TASK.md')))
    return { confirmed: false, reason: 'bundle lacks TASK.md' };
  const missing = run.output!.artifactManifest.find(
    (artifact) => !existsSync(path.join(taskDir, artifact.path)),
  );
  return missing
    ? { confirmed: false, reason: `bundle lacks ${missing.path}` }
    : { confirmed: true, taskDir };
}

/** A new run's prepare clears temp/; a warm handoff, a replay or a resumed task keeps it. */
export function shouldScrubTempForRun(run: Run | undefined): run is Run {
  if (!run) return false;
  const flags = run.engineState?.flags;
  if (flags?.warmSessionReuse && flags.warmHandoffSucceeded !== false) return false;
  const init = run.engineState?.taskInit;
  if (init?.status === 'initialized' && init.taskFile === run.taskFile) return false;
  return !run.steps.some((entry) => entry.name === 'dispatch' && entry.status === 'done');
}

async function parentChain(run: Run): Promise<Run[]> {
  const chain: Run[] = [];
  const seen = new Set<string>();
  for (let id = run.parentRunId; id && !seen.has(id); ) {
    seen.add(id);
    const parent = await getRunWithArchived(id);
    if (!parent) break;
    chain.push(parent);
    id = parent.parentRunId;
  }
  return chain;
}

/**
 * Save a nested checkout's unpushed commits, local branches and dirty work as parked refs in
 * the slot repo (the farm's one parking store, keyed to the slot repo), confirm the slot lists
 * them, then delete the checkout and prune its worktree admin data. Throws, deleting nothing,
 * when any step fails.
 */
async function parkAndRemoveCheckout(
  vars: SlotVars,
  checkout: TempCheckout,
  park: { repoKey: string; operationKey: string; defaultBranch: string },
): Promise<string[]> {
  const where = path.posix.join(vars.remoteRepo.replace(/\/+$/, ''), checkout.path);
  const heads = checkout.branches.map((branch) => ({ branch, headSha: `refs/heads/${branch}` }));
  let refs: string[] = [];
  if (!checkout.bare && !checkout.hasHead) throw new Error('it has no commit to park its work on');
  if (!checkout.bare || heads.length) {
    const capture = await parkGitWork(
      { ...vars, remoteRepo: where },
      {
        slotId: vars.slotId,
        operationKey: park.operationKey,
        defaultBranch: park.defaultBranch,
        purpose: 'prior-work',
        at: new Date().toISOString(),
        repoKey: park.repoKey,
        ...(checkout.bare
          ? { includeWorktree: false, sourceHeads: heads }
          : {
              extraRefs: heads
                .filter((head) => head.branch !== checkout.branch)
                .map((head) => head.headSha),
            }),
      },
    );
    refs = capture.receipts.map((receipt) => receipt.ref);
    const specs = refs.flatMap((ref) => {
      const meta = ref.replace('refs/farmslot/parked/', 'refs/farmslot/parked-meta/');
      return [`${ref}:${ref}`, `${meta}:${meta}`];
    });
    if (specs.length) {
      const fetched = await execOnSlot(
        vars,
        `git -C ${shellQuote(vars.remoteRepo)} fetch --quiet --no-tags --no-write-fetch-head ${shellQuote(where)} ${specs.map(shellQuote).join(' ')}`,
        { timeout: 120_000, noRetry: true },
      );
      if (fetched.exitCode !== 0)
        throw new Error(`its parked refs did not reach the slot repo: ${fetched.stderr.trim()}`);
    }
    const listed = await readParkedGitWork(vars, vars.slotId);
    const missing = refs.find((ref) => !listed.receipts.some((receipt) => receipt.ref === ref));
    if (missing) throw new Error(`the slot repo does not list ${missing}`);
  }
  const prune = checkout.linked
    ? ` && git --git-dir=${shellQuote(checkout.commonDir)} worktree prune`
    : '';
  const removed = await execOnSlot(
    vars,
    `rm -rf -- ${shellQuote(where)} && [ ! -e ${shellQuote(where)} ]${prune}`,
    { timeout: 120_000, noRetry: true },
  );
  if (removed.exitCode !== 0)
    throw new Error(`it was parked but not removed: ${removed.stderr.trim() || 'still present'}`);
  return refs;
}

export interface TempScrubOutcome extends TempScrubResult {
  /** Removed task dirs with their run and whether its bundle had them. */
  taskDirs: Array<{ path: string; runId: string | null; bundle: string }>;
  /** Nested checkouts saved as parked refs, then deleted. */
  parked: Array<{ path: string; refs: string[] }>;
}

/**
 * Prepare's clear-out for a new run: everything in temp/ goes except farm state, the task dirs
 * of this run, its parent chain and runs still bound to the slot. Another live run on the slot
 * stops it, since its scratch cannot be told apart; a queued pin or a run parked off the slot
 * does not. Nested checkouts are parked as refs, then deleted; a failed park stops prepare.
 */
export async function scrubTempForRun(
  vars: SlotVars,
  projectJson: RawProjectJson,
  run: Run,
): Promise<TempScrubOutcome | null> {
  const taskDirName = resolveProjectTaskDirName(projectJson);
  if (taskDirName !== TEMP_TASK_ROOT) return null;
  const chain = await parentChain(run);
  const chainIds = new Set([run.id, ...chain.map((owner) => owner.id)]);
  const slotRuns = listRunsForSlotHistory(vars.slotId, { limit: 100 }).runs;
  const row = await readSlotRow(vars.slotId);
  const bound = slotRuns.filter(
    (other) => !chainIds.has(other.id) && !isTerminalRunStatus(other.status),
  );
  const live = bound.find(
    (other) => !slotPinIsRequestOnly(other, row) && !isSlotFreedByPark(other),
  );
  if (live)
    throw new Error(
      `Slot ${vars.slotId} still has live run ${live.id.slice(0, 8)}; temp/ cannot be cleared for a new run. Finish, park or release that run, then prepare again.`,
    );
  const keep = [
    ...tempStatePaths(projectJson),
    ...[run, ...chain, ...bound].flatMap((owner) => slotTaskRelDir(owner, taskDirName) ?? []),
  ];
  const survey = await surveySlotTemp(vars, keep, taskDirName);
  if (survey.refused.length)
    throw new Error(
      `temp/ cannot be cleared: ${survey.refused.map((entry) => `${entry.path} (${entry.reason})`).join('; ')}`,
    );

  // Named before anything goes, so an unreadable bundle is reported with the dir still there.
  const byDir = new Map(
    slotRuns.flatMap((owner) => {
      const rel = slotTaskRelDir(owner, taskDirName);
      return rel ? [[rel, owner] as const] : [];
    }),
  );
  const named: TempScrubOutcome['taskDirs'] = [];
  for (const dir of survey.taskDirs) {
    const owner = byDir.get(dir);
    let bundle = 'no run record';
    if (owner) {
      try {
        const check = await taskBundleCheck(owner);
        bundle = check.confirmed ? 'in its bundle' : `NOT in a bundle (${check.reason})`;
      } catch (error) {
        // Naming only: the dir goes either way, and the reason is shown, not hidden.
        bundle = `bundle unreadable (${(error as Error).message})`;
      }
    }
    named.push({ path: dir, runId: owner?.id ?? null, bundle });
  }

  const parked: TempScrubOutcome['parked'] = [];
  if (survey.checkouts.length) {
    const park = {
      repoKey: (await readParkedGitWork(vars, vars.slotId)).repoKey,
      operationKey: `temp-scrub-${run.id}`,
      defaultBranch: getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH,
    };
    for (const checkout of survey.checkouts) {
      try {
        parked.push({
          path: checkout.path,
          refs: await parkAndRemoveCheckout(vars, checkout, park),
        });
      } catch (error) {
        throw new Error(
          `Could not park nested checkout ${checkout.path} before clearing temp/: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    await persistSlotParkedInventory(vars, execOnSlot);
  }

  const result = await scrubSlotTemp(vars, keep, taskDirName);
  const taskDirs = named.filter(
    (dir) =>
      !result.refused.some(
        (entry) => entry.path === dir.path || entry.path.startsWith(`${dir.path}/`),
      ),
  );
  return { ...result, taskDirs, parked };
}
