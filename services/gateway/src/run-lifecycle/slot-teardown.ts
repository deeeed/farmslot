import { randomUUID } from 'node:crypto';

import { Events, isTerminalRunStatus, type Run } from '@farmslot/protocol';

import {
  execOnSlot,
  loadSlotVars,
  markSlotStatusIf,
  readSlotRow,
  resetSlotIf,
  SLOT_PHASE_RELEASING,
  SLOT_RELEASING_SINCE,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../core/index.js';
import { slotRealpath } from '../core/slot-io.js';
import { tmuxShellSnippet } from '../core/tmux.js';
import { reapSlotPrepareScope } from '../methods/slot/prepare-command.js';
import {
  findActiveGateHeldRunForSlot,
  findGateParkedRunForSlot,
} from '../run-engine/gate-held-lifecycle.js';
import { assertNativeSlotReplacementOwner } from '../runners/native/worker.js';
import { NativeSlotOwnershipError } from '../runners/native/worker-error.js';
import { contextPaneId, stopRunOwnedTmuxWorkers } from '../runners/owned-stop.js';
import { archiveRunnerSessionsForSlotRelease } from '../runners/session-archive.js';
import { isShellProcessCommand, probeRunnerDescendantPid } from '../runners/session-process.js';
import { listRuns, updateRun } from '../runs/store.js';
import { unwatchSlot } from '../tasks/watcher.js';

export interface RunSlotCleanupFence {
  before: Readonly<Record<string, unknown>> | null;
  token?: string;
}

export class RunOwnedResourceCleanupError extends Error {}

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
      slot.current_run_id === run.id &&
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
      candidate.id !== run.id &&
      candidate.slotId === run.slotId &&
      !isTerminalRunStatus(candidate.status),
  );
}

/** Run transitions may never turn a shared workspace release into a global teardown. */
export async function slotTeardownBlocker(run: Run): Promise<string | null> {
  if (!run.slotId) return null;
  const vars = await loadSlotVars(run.slotId);
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
  if (owner !== run.id) return `Slot belongs to ${owner ?? 'no run'}, not ${run.id}`;
  const other = findOtherActiveRunOnSlot(run);
  if (other) return `Another active run ${other.id} uses this slot`;
  const listed = await execOnSlot(
    vars,
    tmuxShellSnippet(
      "list-panes -a -F '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}'",
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
  const ownedShells = new Set<string>();
  for (const line of listed.stdout.split('\n')) {
    const [session, paneId, panePid, cwd] = line.split('\t');
    if (ownedPanes.has(paneId)) {
      const worker = await probeRunnerDescendantPid(vars, panePid);
      if (worker.state !== 'absent')
        return `Worker ownership in pane ${paneId} is not quiescent; slot teardown was skipped`;
      ownedShells.add(panePid);
    } else if (cwd && (cwd === repo || cwd.startsWith(`${repo}/`)))
      return `Tmux session ${session} uses the slot repository and was not created by this run`;
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
  const censusRows = processes.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: match[1],
            parent: match[2],
            group: Number(match[3]),
            identity: match[4].replace(/\s+/g, ' '),
            command: match[5],
          },
        ]
      : [];
  });
  for (const panePid of ownedShells) {
    const root = censusRows.find((row) => row.pid === panePid);
    if (!root) continue; // A preserved dead pane has no process left to classify.
    if (!isShellProcessCommand(root.command) || censusRows.some((row) => row.parent === panePid))
      return `Recorded worker pane process ${panePid} is still occupied; cleanup deferred`;
  }
  const passive = new Set(
    censusRows
      .filter((row) => /^tmux(?:: (?:server|client))?$/.test(row.command.split('/').at(-1) ?? ''))
      .map((row) => row.pid),
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
  let pid = '';
  for (const line of census.stdout.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    if (line.startsWith('n')) {
      const cwd = line.slice(1);
      if (
        (cwd === repo || cwd.startsWith(`${repo}/`)) &&
        !ownedShells.has(pid) &&
        !passive.has(pid) &&
        !ownedProviders.has(pid)
      )
        return `Process ${pid} still uses the slot repository; slot teardown was skipped`;
    }
  }
  // Automatic run cleanup never destroys the configured session itself.
  return null;
}

export async function recordSlotTeardownBlocker(
  run: Run,
  workerBlocker?: string | null,
): Promise<string | null> {
  const reason = workerBlocker ?? (await slotTeardownBlocker(run));
  const updated = updateRun(run.id, { slotTeardownSkipped: reason ?? undefined });
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(Events.RUN_UPDATED, { run: updated });
  return reason;
}

/** Settle our fence before attempting fallible client notification. */
export async function settleFailedRunSlotCleanup(
  run: Run,
  fence: RunSlotCleanupFence,
  error: unknown,
): Promise<string> {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    const updated = updateRun(run.id, { slotTeardownSkipped: reason });
    await releaseRunSlotOwnership(run, fence, reason);
    const { broadcastEvent } = await import('../server.js');
    broadcastEvent(Events.RUN_UPDATED, { run: updated });
  } catch (settleError) {
    throw new AggregateError(
      [error, settleError],
      'Cleanup failed and failure settlement or notification also failed',
    );
  }
  return reason;
}

/** Relinquish this run's leases; warm providers and other owners stay intact. */
export async function releaseRunOwnedCapabilities(
  run: Run,
  deferProviderCleanup = false,
): Promise<void> {
  if (!run.slotId) return;
  if (deferProviderCleanup) {
    const { releaseRuntimeCapabilityOwnershipForRun } =
      await import('../methods/runtime-capabilities.js');
    const result = await releaseRuntimeCapabilityOwnershipForRun(run.slotId, run.id);
    if (!result.ok) throw new Error(result.failures.map((failure) => failure.reason).join('; '));
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

export async function stopRunOwnedTmuxAndWatches(run: Run): Promise<string | null> {
  const blocker = await stopRunOwnedTmuxWorkers(run);
  if (!run.slotId) return blocker;
  const slotId = run.slotId;
  await unwatchSlot(slotId, { expectedRunId: run.id });
  const slot = await readSlotRow(slotId);
  if (slot?.current_run_id !== run.id) return blocker;
  const vars = await loadSlotVars(slotId);
  // The slot's recorded prepare scope (preflight group plus its nohup'd
  // holder) outlives an aborted or kept-alive prepare window in the slot
  // repository; left alive, the occupancy census holds the slot for it. It can
  // belong to another active run sharing the slot, so only reap when none
  // does, and only while this run still owns the slot at the same epoch.
  let prepareBlocker: string | null = null;
  if ((!slot.handoff_run_id || slot.handoff_run_id === run.id) && !findOtherActiveRunOnSlot(run)) {
    try {
      await reapSlotPrepareScope(vars, {
        stillOwned: async () => {
          const row = await readSlotRow(slotId);
          return row?.current_run_id === run.id && row.slot_epoch === slot.slot_epoch;
        },
      });
    } catch (error) {
      // Surfaced as a teardown blocker, so the slot is held with this reason.
      prepareBlocker = error instanceof Error ? error.message : String(error);
    }
  }
  await archiveRunnerSessionsForSlotRelease({ vars, runId: run.id });
  return [blocker, prepareBlocker].filter(Boolean).join('; ') || null;
}

/** Foreign occupancy prevents destructive cleanup, but does not retain a terminal run's pointer. */
export async function releaseRunSlotOwnership(
  run: Run,
  fence: RunSlotCleanupFence,
  blocker: string | null,
): Promise<boolean> {
  if (!run.slotId) return false;
  const before = fence.before;
  const current = (slot: Readonly<Record<string, unknown>>) =>
    slot.current_run_id === run.id &&
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
    return resetSlotIf(run.slotId, current, true);
  }
  await updateSlotStatusIf(run.slotId, current, {
    current_run_id: null,
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
