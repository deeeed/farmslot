import { Events, isTerminalRunStatus, type Run } from '@farmslot/protocol';

import {
  execOnSlot,
  loadSlotVars,
  readSlotField,
  resetSlotIf,
  SLOT_PHASE_RELEASING,
  updateSlotStatusIf,
} from '../core/index.js';
import { slotRealpath } from '../core/slot-io.js';
import { tmuxShellSnippet } from '../core/tmux.js';
import { stopRunOwnedTmuxWorkers } from '../runners/owned-stop.js';
import { archiveRunnerSessionsForSlotRelease } from '../runners/session-archive.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';
import { listRuns, updateRun } from '../runs/store.js';
import { unwatchSlot } from '../tasks/watcher.js';

/** Run transitions may never turn a shared workspace release into a global teardown. */
export async function slotTeardownBlocker(run: Run): Promise<string | null> {
  if (!run.slotId) return null;
  const vars = await loadSlotVars(run.slotId);
  const owner = await readSlotField(run.slotId, 'current_run_id');
  if (owner !== run.id) return `Slot belongs to ${owner ?? 'no run'}, not ${run.id}`;
  const other = listRuns().runs.find(
    (candidate) =>
      candidate.id !== run.id &&
      candidate.slotId === run.slotId &&
      !isTerminalRunStatus(candidate.status),
  );
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
    run.agentContexts?.map((context) => context.target?.paneId).filter(Boolean),
  );
  const ownedShells = new Set<string>();
  for (const line of listed.stdout.split('\n')) {
    const [session, paneId, panePid, cwd] = line.split('\t');
    if (!cwd || (cwd !== repo && !cwd.startsWith(`${repo}/`))) continue;
    if (ownedPanes.has(paneId)) {
      const worker = await probeRunnerDescendantPid(vars, panePid);
      if (worker.state !== 'absent')
        return `Worker ownership in pane ${paneId} is not quiescent; slot teardown was skipped`;
      ownedShells.add(panePid);
    } else
      return `Tmux session ${session} uses the slot repository and was not created by this run`;
  }
  const census = await execOnSlot(vars, `lsof -a -d cwd -Fpn 2>/dev/null`, {
    cwd: '/',
    timeout: 15000,
  });
  if (census.exitCode !== 0 && census.exitCode !== 1)
    return 'Workspace process census is unavailable; slot teardown was skipped';
  const processes = await execOnSlot(vars, 'ps -axo pid=,comm=', { cwd: '/', timeout: 15000 });
  if (processes.exitCode !== 0)
    return 'Workspace process identity census is unavailable; slot teardown was skipped';
  const passive = new Set(
    processes.stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match && match[2].split('/').at(-1) === 'tmux' ? [match[1]] : [];
    }),
  );
  let pid = '';
  for (const line of census.stdout.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    if (line.startsWith('n')) {
      const cwd = line.slice(1);
      if (
        (cwd === repo || cwd.startsWith(`${repo}/`)) &&
        !ownedShells.has(pid) &&
        !passive.has(pid)
      )
        return `Process ${pid} still uses the slot repository; slot teardown was skipped`;
    }
  }
  // Automatic run cleanup never destroys the configured session itself.
  return null;
}

export async function recordSlotTeardownBlocker(run: Run): Promise<string | null> {
  const reason = await slotTeardownBlocker(run);
  const updated = updateRun(run.id, { slotTeardownSkipped: reason ?? undefined });
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(Events.RUN_UPDATED, { run: updated });
  return reason;
}

/** Relinquish this run's leases; warm providers and other owners stay intact. */
export async function releaseRunOwnedCapabilities(
  run: Run,
  deferProviderCleanup = false,
): Promise<void> {
  if (!run.slotId) return;
  const { runtimeCapabilityRelease, releaseRuntimeCapabilityOwnershipForRun } =
    await import('../methods/runtime-capabilities.js');
  const result = deferProviderCleanup
    ? await releaseRuntimeCapabilityOwnershipForRun(run.slotId, run.id)
    : await runtimeCapabilityRelease({
        slotId: run.slotId,
        ownerRunId: run.id,
        keepWarm: true,
      });
  if (!result.ok)
    throw new Error(
      result.failures.map((failure) => `${failure.capabilityId}: ${failure.reason}`).join('; ') ||
        'Run-owned capability release failed',
    );
}

export async function stopRunOwnedTmuxAndWatches(run: Run): Promise<void> {
  await stopRunOwnedTmuxWorkers(run);
  if (!run.slotId) return;
  await unwatchSlot(run.slotId, { expectedRunId: run.id });
  if ((await readSlotField(run.slotId, 'current_run_id')) === run.id)
    await archiveRunnerSessionsForSlotRelease({
      vars: await loadSlotVars(run.slotId),
      runId: run.id,
    });
}

/** Foreign occupancy prevents destructive cleanup, but does not retain a terminal run's pointer. */
export async function releaseRunSlotOwnership(
  run: Run,
  before: Readonly<Record<string, unknown>> | null,
  blocker: string | null,
): Promise<boolean> {
  if (!run.slotId) return false;
  const current = (slot: Readonly<Record<string, unknown>>) =>
    slot.current_run_id === run.id &&
    slot.slot_epoch === before?.slot_epoch &&
    slot.phase !== SLOT_PHASE_RELEASING;
  if (!blocker) return resetSlotIf(run.slotId, current, true);
  await updateSlotStatusIf(run.slotId, current, {
    current_run_id: null,
    current_flow_type: null,
    current_ticket_or_pr: null,
    current_mode: null,
    lifecycle: 'busy',
    phase: 'working',
    ...(before?.handoff_run_id === run.id ? { handoff_run_id: null } : {}),
  });
  return false;
}
