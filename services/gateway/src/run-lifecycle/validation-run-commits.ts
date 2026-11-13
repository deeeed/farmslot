import {
  isRecord,
  isTerminalRunStatus,
  type ParkedRunCommits,
  type Run,
  type SlotParkedCommits,
  slotParkedDetail,
  slotParkedSummary,
} from '@farmslot/protocol';

import type { RawProjectJson, SlotVars } from '../core/config.js';
import type { execOnSlot } from '../core/exec.js';
import { withFarmGitConfig } from '../core/farm-git.js';
import { findUnpushedSlotCommits } from '../core/git-publication.js';
import { readSlotRow, updateSlotStatusIf } from '../core/state.js';
import { shellQuote } from '../core/tmux.js';
import { excludeSlotScaffolding } from '../fleet/slot-scaffolding.js';
import {
  executeParkedGitMutation,
  lookupParkedGitWork,
  type ParkedCapture,
  type ParkedCaptureOptions,
  parkedRestoreTargets,
  ParkedWorkError,
  parkGitWork,
  pruneParkedGitWork,
  readParkedGitWork,
  restoreParkedGitWork,
} from '../host-services/parked-work.js';

interface SlotWorkOptions {
  defaultBranch: string;
  runId?: string;
  operationKey?: string;
  targetBranches?: string[];
  targetTrees?: string[];
}
interface SlotMutationOptions extends SlotWorkOptions {
  verifyWork?: () => Promise<void>;
}

interface SlotWorkCapture extends ParkedCapture {
  assertOwner(): Promise<void>;
}
function sameParkingOwner(
  current: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  return (
    ['slot_epoch', 'current_run_id', 'cleanup_run_id', 'handoff_run_id', 'phase'].every(
      (key) => current[key] === expected[key],
    ) && JSON.stringify(current.workspace_recovery) === JSON.stringify(expected.workspace_recovery)
  );
}

/** Save every threatened head and dirty state before a fenced caller changes Git. */
export async function captureSlotWork(
  vars: SlotVars,
  project: RawProjectJson,
  options: SlotWorkOptions,
  exec: typeof execOnSlot,
): Promise<SlotWorkCapture> {
  const row = await readSlotRow(vars.slotId);
  if (!row) throw new ParkedWorkError('SLOT_MISSING', `Slot ${vars.slotId} has no inventory row`);
  await excludeSlotScaffolding(vars, project, exec);
  const { getRunWithArchived, recordParkedRunCommits } = await import('../runs/store.js');
  const runId =
    options.runId ?? (typeof row.current_run_id === 'string' ? row.current_run_id : undefined);
  const run = runId ? await getRunWithArchived(runId) : undefined;
  const recovery =
    isRecord(row.workspace_recovery) && typeof row.workspace_recovery.id === 'string'
      ? row.workspace_recovery.id
      : undefined;
  const capture = await parkGitWork(
    vars,
    {
      slotId: vars.slotId,
      operationKey:
        options.operationKey ??
        runId ??
        recovery ??
        manualParkKey(
          vars,
          typeof row.releasing_since === 'string' &&
            Number.isFinite(Date.parse(row.releasing_since))
            ? new Date(row.releasing_since)
            : undefined,
        ),
      runId,
      defaultBranch: options.defaultBranch,
      purpose: 'prior-work',
      at: new Date().toISOString(),
      onlyThreatened: true,
      // Other stale tracking refs cannot prove work is still published. Save conservatively
      // against the fetched default; no per-branch network query is needed before reset.
      notRevs: [`origin/${options.defaultBranch}`],
      extraRefs: (options.targetBranches ?? []).map((branch) => `refs/heads/${branch}`),
      targetTrees: options.targetTrees,
    },
    exec,
  );
  if (run) for (const receipt of capture.receipts) await recordParkedRunCommits(run.id, receipt);
  await persistSlotParkedInventory(vars, exec, true, row);
  return {
    ...capture,
    assertOwner: async () => {
      const current = await readSlotRow(vars.slotId);
      if (!current || !sameParkingOwner(current, row))
        throw new ParkedWorkError('OWNER_CHANGED', 'Slot ownership changed after parking');
    },
  };
}

/** The fingerprint and all saved refs are checked inside the node-side reset batch. */
export async function mutateSlotGit(
  vars: SlotVars,
  project: RawProjectJson,
  options: SlotMutationOptions,
  command: string,
  exec: typeof execOnSlot,
): Promise<import('@farmslot/protocol').ExecResult> {
  const capture = await captureSlotWork(vars, project, options, exec);
  await options.verifyWork?.();
  await capture.assertOwner();
  return executeParkedGitMutation(
    vars,
    {
      slotId: vars.slotId,
      extraRefs: (options.targetBranches ?? []).map((branch) => `refs/heads/${branch}`),
      targetTrees: options.targetTrees,
    },
    capture,
    command,
    exec,
  );
}

/**
 * A final run's branch commits must survive cleanup, whether or not it published.
 * Artifact-only code work can also park at COMPLETE; replay holds keep their checkout.
 */
export function parksBranchCommits(run: Run | undefined): run is Run {
  return (
    ownsRunBranch(run) &&
    (isTerminalRunStatus(run.status) ||
      (ownsArtifactOnlyBranch(run) &&
        run.steps.some(
          (step) =>
            step.name === 'complete' && (step.status === 'running' || step.status === 'done'),
        )))
  );
}

/** Only a recorded branch and dispatch baseline can attribute commits to a run. */
export function ownsRunBranch(run: Run | undefined): run is Run {
  return (
    !!run &&
    !!run.branch &&
    !!(run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch) &&
    !run.engineState?.evalExperiment?.blind
  );
}

/** Artifact-only code work may release its checkout before its final terminal state. */
export function ownsArtifactOnlyBranch(run: Run | undefined): run is Run {
  return (
    ownsRunBranch(run) &&
    run.completionPolicy === 'artifact-only' &&
    ['dev', 'fix-bug'].includes(run.flowType)
  );
}

type ParkedHead = ParkedRunCommits;

/**
 * The one park every release uses: the commit stays reachable at
 * `refs/farmslot/parked/<key>/<sha>`, a ref that is created and never moved. Parking the same
 * commit again is a no-op, so a resent command never fails. Returns null, parking nothing, when
 * the checkout fails a check; throws when the ref cannot be written or names another commit.
 */
async function parkHead(
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: {
    key: string;
    /** A local branch to park instead of HEAD. */
    localBranch?: string;
    /** Data-only retention may name a recorded head after its branch disappears. */
    sourceHeadSha?: string;
    /** The checkout must be on this branch. */
    branch?: string;
    /** The exact head the caller inspected; anything committed on top since is refused. */
    headSha?: string;
    /** The commits must descend from this base, which is excluded from the record. */
    baseSha?: string;
    /** Revisions whose history is not counted as parked work. */
    notRevs: string[];
    /** Park only when there are commits outside `notRevs`. */
    requireCommits?: boolean;
    runId?: string;
    defaultBranch?: string;
    purpose?: 'checkpoint' | 'prior-work';
  },
): Promise<ParkedHead | null> {
  const options: ParkedCaptureOptions = {
    slotId: vars.slotId,
    operationKey: checks.key,
    defaultBranch: checks.defaultBranch ?? 'main',
    purpose: checks.purpose ?? 'prior-work',
    at: new Date().toISOString(),
    runId: checks.runId,
    baseSha: checks.baseSha,
    notRevs: checks.notRevs,
    checks: { branch: checks.branch, headSha: checks.headSha, baseSha: checks.baseSha },
    includeWorktree: !checks.localBranch,
    ...(checks.localBranch
      ? {
          sourceHeads: [
            {
              branch: checks.localBranch,
              headSha: checks.sourceHeadSha ?? `refs/heads/${checks.localBranch}`,
            },
          ],
        }
      : {}),
  };
  const capture = await parkGitWork(vars, options, exec);
  const parked = capture.receipts.at(-1);
  return parked && (!checks.requireCommits || parked.commits.length || parked.kind === 'worktree')
    ? parked
    : null;
}

/**
 * Park a checkpoint when branch, baseline and recorded-head evidence match the run's own
 * run's branch that descends from its dispatch baseline. The head stays reachable at
 * `refs/farmslot/parked/<run>/<head>` (created, never moved) and the record is appended to
 * `run.parkedCommits` durably before the caller may reset. Returns null, parking nothing, for
 * any other checkout. A named discard parks whatever the run's phase: its output is going.
 */
export async function parkRunBranchCommits(
  run: Run,
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: {
    defaultBranch: string;
    headSha?: string;
    discard?: boolean;
    dataOnly?: boolean;
    ownedCheckout?: boolean;
  },
): Promise<ParkedRunCommits | null> {
  if (
    !(checks.discard ? ownsRunBranch(run) : parksBranchCommits(run)) ||
    run.branch === checks.defaultBranch
  )
    return null;
  const baseSha = (run.startRef?.resolvedSha ?? run.worktreeHeadAtDispatch)!;
  const branch = run.branch!;
  const checkpoint = run.releasedCheckout;
  const review = run.steps.find((step) => step.name === 'review')?.outputs?.reviewSnapshot;
  const previous = parkedBranchHead(run, vars.slotId, branch);
  const recorded = [
    {
      head:
        checkpoint?.slotId === vars.slotId && checkpoint.branch === branch
          ? checkpoint.headSha
          : undefined,
      at: checkpoint?.at,
    },
    { head: previous?.sourceHeadSha ?? previous?.headSha, at: previous?.parkedAt },
    {
      head: isRecord(review) && typeof review.headSha === 'string' ? review.headSha : undefined,
      at: isRecord(review) && typeof review.capturedAt === 'string' ? review.capturedAt : undefined,
    },
  ]
    .filter((entry) => entry.head && /^[a-f0-9]{40}$/i.test(entry.head))
    .sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  // A run may record divergent review and release heads. Keep each history; its branch
  // may already be gone or reused. Metadata-only retention never changes that checkout.
  const sources = checks.dataOnly
    ? [
        ...new Set(recorded.reverse().map((entry) => entry.head)),
        ...(checks.ownedCheckout ? [undefined] : []),
      ]
    : [undefined];
  let retained: ParkedRunCommits | null = null;
  for (const sourceHeadSha of sources) {
    const parked = await parkHead(vars, exec, {
      key: run.id,
      runId: run.id,
      purpose: 'checkpoint',
      defaultBranch: checks.defaultBranch,
      ...(checks.dataOnly ? { localBranch: branch, sourceHeadSha } : { branch }),
      // An ownerless return names the head the run left: anything committed on top since is not its.
      headSha: checks.headSha,
      baseSha,
      notRevs: [baseSha, '--remotes'],
    });
    if (!parked) continue;
    const record: ParkedRunCommits = {
      ...parked,
      slotId: vars.slotId,
      ref: parked.ref,
      branch,
      baseSha,
      headSha: parked.headSha,
      commits: parked.commits,
      parkedAt: parked.parkedAt,
    };
    // A failed durable write throws before any caller may reset.
    const { recordParkedRunCommits } = await import('../runs/store.js');
    await recordParkedRunCommits(
      run.id,
      record,
      checks.dataOnly && sourceHeadSha ? previous?.ref : undefined,
    );
    console.log(
      `[slot.release] ${vars.slotId}: parked run ${run.id.slice(0, 8)}'s ${record.commits.length} unpushed commit(s) on ${branch} at ${record.ref}`,
    );
    await persistSlotParkedInventory(vars, exec);
    retained = record;
  }
  return retained;
}

/** A ref component from a slot id: anything but letters, digits, `_` and `-` becomes `-`. */
function refSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * An ownerless slot's unpushed commits have no run to record them, so the same park keys them
 * by slot: `refs/farmslot/parked/manual-<slot>-<ts>/<sha>`. Inspection already classified the
 * work as unpushed, so the park does not decide that again: it parks the inspected HEAD and
 * counts its commits the way inspection does, against `origin/<default>`. Returns null only when
 * HEAD moved since the inspection.
 */
export async function parkSlotCommits(
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: { headSha: string; defaultBranch: string; now?: Date },
): Promise<SlotParkedCommits | null> {
  const parked = await parkHead(vars, exec, {
    key: manualParkKey(vars, checks.now),
    defaultBranch: checks.defaultBranch,
    headSha: checks.headSha,
    notRevs: [`origin/${checks.defaultBranch}`],
  });
  if (parked) await persistSlotParkedInventory(vars, exec);
  return parked && report(vars, parked);
}

/**
 * A reset that switches to `branch` overwrites that local branch too, so its commits missing
 * from `origin/<default>` are parked first. Returns null when it holds none or does not exist.
 */
export async function parkSlotBranch(
  vars: SlotVars,
  exec: typeof execOnSlot,
  checks: { branch: string; defaultBranch: string; headSha: string; now?: Date },
): Promise<SlotParkedCommits | null> {
  const parked = await parkHead(vars, exec, {
    key: manualParkKey(vars, checks.now),
    defaultBranch: checks.defaultBranch,
    localBranch: checks.branch,
    // Commits HEAD also holds are already parked with it.
    notRevs: [`origin/${checks.defaultBranch}`, checks.headSha],
    requireCommits: true,
  });
  if (parked) await persistSlotParkedInventory(vars, exec);
  return parked && report(vars, parked);
}

function manualParkKey(vars: SlotVars, now = new Date()): string {
  return `manual-${refSafe(vars.slotId)}-${now.toISOString().replace(/[-:.]/g, '')}`;
}

function report(vars: SlotVars, parked: ParkedHead): SlotParkedCommits {
  const entry = slotParkedSummary(parked);
  console.log(`[slot.release] ${vars.slotId}: ${slotParkedDetail([entry])}`);
  return entry;
}

/**
 * Keep an unpushed branch discoverable after cleanup, including for a new run of the ticket.
 * Only a fully published, unchanged branch may be deleted. The parked ref remains durable;
 * prepare can recreate a legacy dropped branch from it (`restoreParkedBranch`).
 */
export async function dropParkedBranch(
  parked: ParkedRunCommits,
  vars: SlotVars,
  exec: typeof execOnSlot,
): Promise<string | null> {
  // A skip-prepare rerun may inherit unpublished work as its baseline, so an
  // empty run-local receipt alone cannot authorize deleting the whole branch.
  if (parked.commits.length || (await findUnpushedSlotCommits(vars, parked.headSha, exec)).length)
    return `kept branch ${parked.branch} (unpushed commits)`;
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const dropped = await exec(
    vars,
    withFarmGitConfig(
      `${git} update-ref -d ${shellQuote(`refs/heads/${parked.branch}`)} ${shellQuote(parked.headSha)}`,
    ),
  );
  return dropped.exitCode === 0
    ? null
    : `kept branch ${parked.branch} (it moved): ${(dropped.stderr || dropped.stdout).trim()}`;
}

/**
 * A replay's prepare restores the run's dropped branch at its latest parked head on this slot.
 * The branch is created, never moved: returns null if there is no parking or the branch exists.
 */
export async function restoreParkedBranch(
  run: Pick<Run, 'parkedCommits'> | undefined,
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot,
  options: { project: RawProjectJson; defaultBranch: string } = {
    project: {},
    defaultBranch: 'main',
  },
): Promise<ParkedRunCommits | null> {
  const parked = parkedBranchHead(run, vars.slotId, branch);
  if (!parked) return null;
  const retained = await lookupParkedGitWork(vars, vars.slotId, parked.ref, exec);
  if (parked.prunedAt || retained.headSha !== parked.headSha)
    throw new ParkedWorkError(
      'SNAPSHOT_MISSING',
      `Replay checkpoint ${parked.ref} is missing or pruned; restore a retained checkpoint before replay`,
    );
  if (parked.kind === 'worktree') {
    const local = await exec(
      vars,
      withFarmGitConfig(
        `git -C ${shellQuote(vars.remoteRepo)} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
      ),
    );
    if (local.exitCode === 0) return null;
    if (local.exitCode !== 1)
      throw new ParkedWorkError('GIT_FAILED', 'Cannot inspect the replay branch');
    const targetTrees = parkedRestoreTargets(parked);
    const capture = await captureSlotWork(
      vars,
      options.project,
      {
        defaultBranch: options.defaultBranch,
        targetBranches: [branch],
        targetTrees,
      },
      exec,
    );
    await capture.assertOwner();
    await restoreParkedGitWork(
      vars,
      {
        slotId: vars.slotId,
        extraRefs: [`refs/heads/${branch}`],
        targetTrees,
        restoreBranch: branch,
      },
      capture,
      parked,
      exec,
    );
    return parked;
  }
  const restored = await exec(
    vars,
    withFarmGitConfig(
      `git -C ${shellQuote(vars.remoteRepo)} update-ref ${shellQuote(`refs/heads/${branch}`)} ${shellQuote(parked.headSha)} ''`,
    ),
  );
  return restored.exitCode === 0 ? parked : null;
}

/** The latest parked head of `branch` for this run on this slot. */
function parkedBranchHead(
  run: Pick<Run, 'parkedCommits'> | undefined,
  slotId: string,
  branch: string,
): ParkedRunCommits | undefined {
  return run?.parkedCommits
    ?.filter(
      (entry) =>
        entry.slotId === slotId && entry.branch === branch && entry.purpose !== 'prior-work',
    )
    .at(-1);
}

/**
 * A release that keeps an artifact-only run's checkout (COMPLETE, an interactive done-no-pr, a
 * failed run) records the head it leaves while the run still owns the slot, so a later ownerless
 * return to idle parks exactly that. Whether it parks is decided then, once the run has finished.
 */
export async function recordReleasedCheckout(
  run: Run,
  vars: SlotVars,
  exec: typeof execOnSlot,
): Promise<void> {
  if (!ownsRunBranch(run)) return;
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const read = await exec(
    vars,
    withFarmGitConfig(`${git} symbolic-ref --quiet --short HEAD && ${git} rev-parse HEAD`),
  );
  const [branch, headSha] = read.stdout.trim().split('\n');
  if (read.exitCode !== 0 || branch !== run.branch || !headSha) return;
  const { recordRunReleasedCheckout } = await import('../runs/store.js');
  await recordRunReleasedCheckout(run.id, {
    slotId: vars.slotId,
    branch,
    headSha,
    at: new Date().toISOString(),
  });
}

/** The durable binding survives the transient workspace-recovery marker. */
export async function persistSlotParkedInventory(
  vars: SlotVars,
  exec: typeof execOnSlot,
  required = false,
  expected?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const row = await readSlotRow(vars.slotId);
  if (!row) {
    // Data-only retention can outlive a retired pool slot; it performs no reset.
    if (required)
      throw new ParkedWorkError(
        'REGISTRATION_FAILED',
        `Slot ${vars.slotId} disappeared before parking registration`,
      );
    return;
  }
  const inventory = await slotParkedInventory(vars, exec);
  const binding = {
    namespace: inventory.namespace,
    repoKey: inventory.repoKey,
    ...inventory.summary,
  };
  const identity = expected ?? row;
  const saved = await updateSlotStatusIf(
    vars.slotId,
    (current) => sameParkingOwner(current, identity),
    { parked_work: binding },
  );
  if (!saved && required)
    throw new ParkedWorkError(
      'REGISTRATION_FAILED',
      `Slot ${vars.slotId} disappeared before parking registration`,
    );
}

/** A narrow inventory reconciles legacy refs from their exact recorded run, never a run scan. */
export async function slotParkedInventory(vars: SlotVars, exec: typeof execOnSlot) {
  const inventory = await readParkedGitWork(vars, vars.slotId, exec);
  const legacy: import('@farmslot/protocol').LegacyParkedWork[] = [];
  const { getRunWithArchived } = await import('../runs/store.js');
  for (const row of inventory.legacy) {
    const key = row.ref.split('/')[3];
    const run = key?.startsWith('manual-') ? undefined : await getRunWithArchived(key);
    const record = run?.parkedCommits?.find(
      (entry) =>
        entry.slotId === vars.slotId && entry.ref === row.ref && entry.headSha === row.headSha,
    );
    if (record) inventory.receipts.push(record);
    else if (key?.startsWith(`manual-${refSafe(vars.slotId)}-`))
      legacy.push({
        ...row,
        reason: 'Legacy commit backup; original branch and parking time are unavailable',
      });
  }
  const latest = inventory.receipts
    .filter((receipt) => Number.isFinite(Date.parse(receipt.parkedAt)))
    .slice()
    .sort((a, b) => Date.parse(b.parkedAt) - Date.parse(a.parkedAt))[0];
  return {
    ...inventory,
    legacy,
    summary: {
      count: inventory.receipts.length + legacy.length,
      latestRef: latest?.ref ?? null,
      latestAt: latest?.parkedAt ?? null,
    },
  };
}

export async function restoreSlotParkedWork(
  vars: SlotVars,
  project: RawProjectJson,
  defaultBranch: string,
  ref: string,
  verifyWork: () => Promise<void>,
  exec: typeof execOnSlot,
) {
  const inventory = await slotParkedInventory(vars, exec);
  const receipt =
    inventory.receipts.find((entry) => entry.ref === ref) ??
    inventory.legacy.find((entry) => entry.ref === ref);
  if (!receipt)
    throw new ParkedWorkError(
      'SNAPSHOT_MISSING',
      'Select a retained snapshot from this slot inventory',
    );
  const options = { defaultBranch, targetTrees: parkedRestoreTargets(receipt) };
  const capture = await captureSlotWork(vars, project, options, exec);
  await verifyWork();
  await capture.assertOwner();
  return restoreParkedGitWork(
    vars,
    { slotId: vars.slotId, targetTrees: options.targetTrees },
    capture,
    receipt,
    exec,
  );
}

/** Called by the existing retention owner only on fenced, unowned idle slots. */
export async function retainSlotParkedWork(
  vars: SlotVars,
  protectedRefs: string[],
  now: Date,
  days: number,
  exec: typeof execOnSlot,
): Promise<void> {
  const inventory = await slotParkedInventory(vars, exec);
  const pruned = await pruneParkedGitWork(
    vars,
    vars.slotId,
    inventory.receipts,
    protectedRefs,
    new Date(now.getTime() - days * 86_400_000).toISOString(),
    now.toISOString(),
    exec,
  );
  const { recordParkedRunCommits } = await import('../runs/store.js');
  for (const receipt of pruned)
    if (receipt.runId) await recordParkedRunCommits(receipt.runId, receipt);
  await persistSlotParkedInventory(vars, exec, true);
}
