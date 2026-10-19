import { randomUUID } from 'node:crypto';

import {
  Events,
  isCompletionPrerequisiteFailure,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import {
  execOnSlot,
  loadSlotVars,
  markSlotStatusIf,
  ownsRunSlotCleanup,
  readSlotRow,
  resetSlotIf,
  SLOT_PHASE_RELEASING,
  SLOT_RELEASING_SINCE,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../core/index.js';
import { slotRealpath } from '../core/slot-io.js';
import { resolveTmuxSession, tmuxShellSnippet } from '../core/tmux.js';
import { isActiveSlotHolder } from '../methods/dispatch/slot-scoring.js';
import { reapSlotPrepareScope } from '../methods/slot/prepare-command.js';
import {
  findActiveGateHeldRunForSlot,
  findGateParkedRunForSlot,
} from '../run-engine/gate-held-lifecycle.js';
import {
  beginTerminalTeardown,
  endTerminalTeardown,
  isTerminalTeardownInFlight,
} from '../run-engine/terminal-teardown-registry.js';
import { assertNativeSlotReplacementOwner } from '../runners/native/worker.js';
import { NativeSlotOwnershipError } from '../runners/native/worker-error.js';
import { quiescentHistoricalWorkerPanes, stopRunOwnedTmuxWorkers } from '../runners/owned-stop.js';
import { archiveRunnerSessionsForSlotRelease } from '../runners/session-archive.js';
import { isShellProcessCommand, probeRunnerDescendantPid } from '../runners/session-process.js';
import { contextPaneId } from '../runners/session-record.js';
import { getRun, getRunWithArchived, listRuns, updateRun } from '../runs/store.js';
import { unwatchSlot } from '../tasks/watcher.js';

import { reapSlotBrowserSession } from './browser-session-reap.js';
import {
  isTmuxProcess,
  isWithinPath,
  parseLsofNames,
  parseProcessCensus,
} from './process-census.js';

export interface RunSlotCleanupFence {
  before: Readonly<Record<string, unknown>> | null;
  token?: string;
}

export class RunOwnedResourceCleanupError extends Error {}

/** Recheck a durable hold through the same guarded cleanup that created it. */
export async function retryOccupiedRunSlot(slotId: string): Promise<boolean> {
  if (isTerminalTeardownInFlight(slotId)) return false;
  const before = await readSlotRow(slotId);
  if (before?.lifecycle !== 'held' || before.phase !== 'occupied') return false;
  const runId = before.current_run_id || before.cleanup_run_id;
  if (typeof runId !== 'string') return false; // An unidentified foreign hold grants no cleanup authority.
  const run = await getRunWithArchived(runId);
  if (
    !run ||
    run.slotId !== slotId ||
    !isTerminalRunStatus(run.status) ||
    // A cancelled run keeps its slot for replay until release, delete or archive (ADR-054).
    run.status === 'cancelled' ||
    isCompletionPrerequisiteFailure(run) ||
    isActiveSlotHolder(run)
  )
    return false;
  if (isTerminalTeardownInFlight(slotId)) return false;
  beginTerminalTeardown(slotId);
  try {
    const current = await readSlotRow(slotId);
    if (
      current?.slot_epoch !== before.slot_epoch ||
      current?.phase !== 'occupied' ||
      !ownsRunSlotCleanup(current, run.id)
    )
      return false;
    const { releaseCompletedRunSlot } = await import('../methods/run/lifecycle-control.js');
    return (await releaseCompletedRunSlot(run)).released;
  } finally {
    endTerminalTeardown(slotId);
  }
}

export async function fenceRunSlotCleanup(
  run: Run,
  blocker: string | null,
): Promise<RunSlotCleanupFence> {
  if (!run.slotId) return { before: null };
  const before = await readSlotRow(run.slotId);
  if (blocker) return { before };
  const token = randomUUID();
  const marked = await markSlotStatusIf(
    run.slotId,
    (slot) =>
      ownsRunSlotCleanup(slot, run.id) &&
      slot.slot_epoch === before?.slot_epoch &&
      slot.phase !== SLOT_PHASE_RELEASING &&
      !slot.handoff_run_id,
    { ...slotReleasingFenceFields(), cleanup_release_token: token },
  );
  if (!marked.applied) throw new Error('Slot ownership changed before cleanup could be fenced');
  return { before, token };
}

/** A non-terminal run other than `run` that is bound to the same slot. */
function findOtherActiveRunOnSlot(run: Run): Run | undefined {
  return listRuns().runs.find(
    (candidate) =>
      candidate.id !== run.id && candidate.slotId === run.slotId && isActiveSlotHolder(candidate),
  );
}

/** Another run, reservation or release that owns this slot keeps it; cancel checks only this. */
export async function slotOwnershipBlocker(run: Run): Promise<string | null> {
  if (!run.slotId) return null;
  const row = await readSlotRow(run.slotId);
  const owner = row?.current_run_id;
  if (row?.phase === SLOT_PHASE_RELEASING) return 'Another slot release is in progress';
  if (row?.handoff_run_id && row.handoff_run_id !== run.id)
    return 'Another native handoff owns this slot reservation';
  if (findActiveGateHeldRunForSlot(run.slotId)) return 'A publication gate still holds this slot';
  if (findGateParkedRunForSlot(run.slotId)?.id === run.id)
    return 'A gate park still protects this workspace';
  try {
    assertNativeSlotReplacementOwner(run.slotId, run.id);
  } catch (error) {
    if (!(error instanceof NativeSlotOwnershipError)) throw error;
    return error.message; // Foreign native ownership is a durable cleanup blocker.
  }
  if (!ownsRunSlotCleanup(row, run.id))
    return `Slot belongs to ${owner ?? 'no run'}, not ${run.id}`;
  const other = findOtherActiveRunOnSlot(run);
  if (other) return `Another active run ${other.id} uses this slot`;
  return null;
}

/** Run transitions may never turn a shared workspace release into a global teardown. */
export async function slotTeardownBlocker(run: Run): Promise<string | null> {
  if (!run.slotId) return null;
  const ownership = await slotOwnershipBlocker(run);
  if (ownership) return ownership;
  const vars = await loadSlotVars(run.slotId);
  const listed = await execOnSlot(
    vars,
    tmuxShellSnippet(
      "list-panes -a -F '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{session_path}\t#{session_id}\t#{session_created}'",
    ),
    { cwd: '/' },
  );
  if (listed.exitCode !== 0 && listed.exitCode !== 1)
    return 'Tmux ownership inspection failed; slot teardown was skipped';
  const repo = (await slotRealpath(vars, vars.remoteRepo)).replace(/\/$/, '');
  const ownedPanes = new Set(
    run.agentContexts
      ?.map((context) => context.target && contextPaneId(context.target))
      .filter(Boolean),
  );
  for (const context of run.agentContexts ?? []) {
    if (
      (context.slotId ?? run.slotId) !== run.slotId ||
      !context.target ||
      context.nativeSession ||
      context.nativeSessionOwner ||
      contextPaneId(context.target)
    )
      continue;
    const historical = await quiescentHistoricalWorkerPanes(vars, run, context);
    if (historical === null)
      return `Worker ${context.id} target is not quiescent; verify it before retrying slot release`;
    for (const paneId of historical) ownedPanes.add(paneId);
  }
  const ownedShells = new Set<string>();
  let slotSession: string | undefined;
  const sessionOrigins = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    const [session, paneId, panePid, cwd, origin, sessionId, createdAt] = line.split('\t');
    if (ownedPanes.has(paneId)) {
      const worker = await probeRunnerDescendantPid(vars, panePid);
      if (worker.state !== 'absent')
        return `Worker ownership in pane ${paneId} is not quiescent; slot teardown was skipped`;
      ownedShells.add(panePid);
    } else if (cwd && isWithinPath(repo, cwd)) {
      slotSession ??= await resolveTmuxSession(run.slotId, vars, { strict: true });
      if (
        !isTerminalRunStatus(run.status) ||
        session !== slotSession ||
        !origin ||
        !/^\$\d+$/.test(sessionId ?? '') ||
        !/^\d+$/.test(createdAt ?? '') ||
        Number(createdAt) <= 0
      )
        return `Tmux session ${session} uses the slot repository without verified slot ownership`;
      if (!sessionOrigins.has(origin))
        sessionOrigins.set(origin, (await slotRealpath(vars, origin)).replace(/\/$/, ''));
      if (sessionOrigins.get(origin) !== repo)
        return `Tmux session ${session} was started outside this slot checkout; cleanup deferred`;
      // A slot session survives its runs. Its unrecorded idle shells own no
      // conversation, but a live or unknown worker still blocks cleanup.
      if ((await probeRunnerDescendantPid(vars, panePid)).state !== 'absent')
        return `Unrecorded pane ${paneId} in slot session ${session} is not quiescent; cleanup deferred`;
      ownedShells.add(panePid);
    }
  }
  const { getRuntimeCapabilityRegistry } = await import('../methods/runtime-capabilities.js');
  const status = await getRuntimeCapabilityRegistry().settledStatus(run.slotId);
  const census = await execOnSlot(vars, `lsof -a -d cwd -Fpn 2>/dev/null`, {
    cwd: '/',
    timeout: 15000,
  });
  if (census.exitCode !== 0 && census.exitCode !== 1)
    return 'Workspace process census is unavailable; slot teardown was skipped';
  const processes = await execOnSlot(vars, 'ps -axo pid=,ppid=,pgid=,lstart=,comm=', {
    cwd: '/',
    timeout: 15000,
  });
  if (processes.exitCode !== 0)
    return 'Workspace process identity census is unavailable; slot teardown was skipped';
  const censusRows = parseProcessCensus(processes.stdout);
  for (const panePid of ownedShells) {
    const root = censusRows.find((row) => row.pid === panePid);
    if (!root) continue; // A preserved dead pane has no process left to classify.
    if (!isShellProcessCommand(root.command) || censusRows.some((row) => row.parent === panePid))
      return `Recorded worker pane process ${panePid} is still occupied; cleanup deferred`;
  }
  const passive = new Set(
    censusRows.filter((row) => isTmuxProcess(row.command)).map((row) => row.pid),
  );
  const ownedProviders = new Set<string>();
  const ownedGroups = new Set<number>();
  for (const lease of status.leases.filter(
    (lease) =>
      lease.owner.runId === run.id &&
      (lease.state === 'acquired' || lease.keepWarmUntil || lease.providerCleanupDeferred),
  )) {
    for (const frame of lease.providerProcesses ?? []) {
      if (
        !censusRows.some(
          (row) =>
            Number(row.pid) === frame.pid &&
            row.identity === frame.identity &&
            row.group === frame.group,
        )
      )
        continue;
      ownedProviders.add(String(frame.pid));
      if (frame.group === frame.pid) ownedGroups.add(frame.group);
    }
  }
  // A declared slot resource (the dev server dispatch needs) lives in the
  // checkout across runs: its watched process and group are residents.
  const { getActiveResources } = await import('../fleet/resource-manager.js');
  for (const resource of getActiveResources(run.slotId)?.values() ?? []) {
    const row = censusRows.find((candidate) => Number(candidate.pid) === resource.pid);
    if (!row) continue;
    ownedProviders.add(row.pid);
    if (row.group === resource.pid) ownedGroups.add(row.group);
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of censusRows) {
      if (
        !ownedProviders.has(row.pid) &&
        (ownedProviders.has(row.parent) || ownedGroups.has(row.group))
      ) {
        ownedProviders.add(row.pid);
        added = true;
      }
    }
  }
  // An unreadable identity is still a live occupant, never evidence of exit.
  const livePids = new Set(
    processes.stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s/.exec(line);
      return match ? [match[1]] : [];
    }),
  );
  if (census.stdout.trim() && livePids.size === 0)
    return 'Workspace process identity census is unreadable; slot teardown was skipped';
  for (const [pid, cwd] of parseLsofNames(census.stdout)) {
    if (
      isWithinPath(repo, cwd) &&
      livePids.has(pid) &&
      !ownedShells.has(pid) &&
      !passive.has(pid) &&
      !ownedProviders.has(pid)
    )
      return `Process ${pid} still uses the slot repository; slot teardown was skipped`;
  }
  // Automatic run cleanup never destroys the configured session itself.
  return null;
}

export async function recordSlotTeardownBlocker(
  run: Run,
  workerBlocker?: string | null,
): Promise<string | null> {
  const reason = workerBlocker ?? (await slotTeardownBlocker(run));
  await recordSlotTeardownSkipped(run, reason);
  return reason;
}

/** Name what slot cleanup kept or could not stop on the run, or clear it. */
export async function recordSlotTeardownSkipped(run: Run, reason: string | null): Promise<void> {
  if (!getRun(run.id)) return;
  const updated = updateRun(run.id, { slotTeardownSkipped: reason ?? undefined });
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(Events.RUN_UPDATED, { run: updated });
}

/** Settle our fence before attempting fallible client notification. */
export async function settleFailedRunSlotCleanup(
  run: Run,
  fence: RunSlotCleanupFence,
  error: unknown,
): Promise<string> {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await releaseRunSlotOwnership(run, fence, reason);
    if (getRun(run.id)) {
      const updated = updateRun(run.id, { slotTeardownSkipped: reason });
      const { broadcastEvent } = await import('../server.js');
      broadcastEvent(Events.RUN_UPDATED, { run: updated });
    }
  } catch (settleError) {
    throw new AggregateError(
      [error, settleError],
      'Cleanup failed and failure settlement or notification also failed',
    );
  }
  return reason;
}

/** Relinquish this run's leases; warm providers and other owners stay intact. */
export async function releaseRunOwnedCapabilities(run: Run): Promise<void> {
  if (!run.slotId) return;
  // Workspace occupants do not own this run's providers. The registry checks
  // each provider's recorded process identity and protects other lease holders.
  // Deferring every provider behind an unrelated pane stranded device claims.
  if (!getRun(run.id)) {
    const { getRuntimeCapabilityRegistry } = await import('../methods/runtime-capabilities.js');
    const result = await getRuntimeCapabilityRegistry().releaseRunTerminal(run.slotId, run.id);
    if (!result.ok)
      throw new RunOwnedResourceCleanupError(
        result.failures.map((failure) => failure.reason).join('; '),
      );
    return;
  }
  const { getRunResourcePostureReconciler } = await import('../methods/runtime-posture.js');
  const result = await getRunResourcePostureReconciler().apply({
    runId: run.id,
    posture: 'terminal',
    ownerOnly: true,
  });
  if (!result.ok)
    throw new RunOwnedResourceCleanupError(
      `Run-owned terminal resource cleanup failed: ${result.transition.failures.map((failure) => failure.reason).join('; ') || result.transition.outcome}`,
    );
}

export async function stopRunOwnedTmuxAndWatches(
  run: Run,
  { stopUnverifiedWorkers = false }: { stopUnverifiedWorkers?: boolean } = {},
): Promise<string | null> {
  let blocker = await stopRunOwnedTmuxWorkers(run);
  if (!run.slotId) return blocker;
  const slotId = run.slotId;
  await unwatchSlot(slotId, { expectedRunId: run.id });
  const slot = await readSlotRow(slotId);
  if (!ownsRunSlotCleanup(slot, run.id)) return blocker;
  const vars = await loadSlotVars(slotId);
  // The slot's recorded prepare scope (preflight group plus its nohup'd
  // holder) outlives an aborted or kept-alive prepare window in the slot
  // repository; left alive, the occupancy census holds the slot for it. It can
  // belong to another active run sharing the slot, so only reap when none
  // does, and only while this run still owns the slot at the same epoch.
  let prepareBlocker: string | null = null;
  let browserBlocker: string | null = null;
  if ((!slot?.handoff_run_id || slot.handoff_run_id === run.id) && !findOtherActiveRunOnSlot(run)) {
    if (blocker && stopUnverifiedWorkers) {
      // Cancel owns its workers through agentContexts, recorded identity or not:
      // stop them the way slot.release does (ADR-054 amendment, 2026-10-19).
      const { killSlotAgents } = await import('../methods/slot/release.js');
      try {
        await killSlotAgents(slotId, run.id);
        blocker = null;
      } catch (error) {
        // A worker that could not be stopped is named; it does not keep the slot.
        blocker = error instanceof Error ? error.message : String(error);
      }
    }
    const stillOwned = async () => {
      const row = await readSlotRow(slotId);
      return ownsRunSlotCleanup(row, run.id) && row?.slot_epoch === slot?.slot_epoch;
    };
    try {
      await reapSlotPrepareScope(vars, { stillOwned });
    } catch (error) {
      // Surfaced as a teardown blocker, so the slot is held with this reason.
      prepareBlocker = error instanceof Error ? error.message : String(error);
    }
    try {
      browserBlocker = await reapSlotBrowserSession(vars, { stillOwned });
    } catch (error) {
      browserBlocker = error instanceof Error ? error.message : String(error);
    }
  }
  await archiveRunnerSessionsForSlotRelease({ vars, runId: run.id });
  return [blocker, prepareBlocker, browserBlocker].filter(Boolean).join('; ') || null;
}

/** Foreign occupancy prevents destructive cleanup, but does not retain a terminal run's pointer. */
/** What a cancelled run's slot shows while it is kept for replay (ADR-054, 2026-10-19). */
export function cancelledRunHoldReason(runId: string): string {
  return `Held by cancelled run ${runId}: replay it or release the slot`;
}

export async function releaseRunSlotOwnership(
  run: Run,
  fence: RunSlotCleanupFence,
  blocker: string | null,
  { keepForReplay = false }: { keepForReplay?: boolean } = {},
): Promise<boolean> {
  if (!run.slotId) return false;
  const before = fence.before;
  const current = (slot: Readonly<Record<string, unknown>>) =>
    ownsRunSlotCleanup(slot, run.id) &&
    slot.slot_epoch === before?.slot_epoch &&
    (!slot.handoff_run_id || slot.handoff_run_id === run.id) &&
    (fence.token
      ? slot.phase === SLOT_PHASE_RELEASING && slot.cleanup_release_token === fence.token
      : slot.phase !== SLOT_PHASE_RELEASING);
  if (!blocker) {
    const assertOwned = async () => {
      const row = await readSlotRow(run.slotId!);
      if (!row || !current(row)) throw new Error('Slot ownership changed during ancillary cleanup');
    };
    await assertOwned();
    const { terminalAttachmentCleanupForRun } = await import('../methods/terminal-attachment.js');
    await terminalAttachmentCleanupForRun(run, assertOwned);
    const { killSlotScreenSessions } = await import('../runtime/screen-session.js');
    await assertOwned();
    killSlotScreenSessions(run.slotId, run.id);
    if (keepForReplay)
      // The checkout and the run's ownership stay, so run.replayStep can reclaim the slot.
      return updateSlotStatusIf(run.slotId, current, {
        lifecycle: 'held',
        phase: 'occupied',
        held_reason: cancelledRunHoldReason(run.id),
        cleanup_release_token: null,
        [SLOT_RELEASING_SINCE]: null,
        agent: 'idle',
        ...(before?.handoff_run_id === run.id ? { handoff_run_id: null } : {}),
      });
    return resetSlotIf(run.slotId, current, true);
  }
  await updateSlotStatusIf(run.slotId, current, {
    current_run_id: null,
    cleanup_run_id: run.id,
    current_flow_type: null,
    current_ticket_or_pr: null,
    current_mode: null,
    current_family_id: null,
    current_lane: null,
    current_variant: null,
    active_task_file: null,
    lifecycle: 'held',
    phase: 'occupied',
    held_reason: blocker,
    cleanup_release_token: null,
    [SLOT_RELEASING_SINCE]: null,
    agent: 'idle',
    ...(before?.handoff_run_id === run.id ? { handoff_run_id: null } : {}),
  });
  return false;
}
