import { RUN_LIST_UNLIMITED } from '@farmslot/protocol';

import { withCleanupSignal } from '../core/cleanup-scope.js';
import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { activePrepareSlots } from '../core/native-worker-exclusion.js';
import { reportSlotResourceLifecycle } from '../core/resource-lifecycle-log.js';
import { slotRealpath } from '../core/slot-io.js';
import { markSlotStatusIf, readSlotRow } from '../core/state.js';
import { resolveTmuxSession, tmuxShellSnippet } from '../core/tmux.js';
import {
  deleteActiveResource,
  executeResourceControl,
  getActiveResource,
  probeResourceStatus,
  resolveSlotResources,
  setActiveResource,
  setCachedResourceStatus,
} from '../fleet/resource-manager.js';
import { getRuntimeCapabilityRegistry } from '../methods/runtime-capabilities.js';
import { activePrepareAborts } from '../methods/slot/shared.js';
import { readRunProgress } from '../runners/run-progress.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';
import { contextPaneId } from '../runners/session-record.js';
import { listRuns } from '../runs/store.js';

import { IdleDevServerReaper } from './idle-devserver.js';
import { isTmuxProcess, isWithinPath, parseProcessCensus } from './process-census.js';
import { reapIdentifiedSlotProcesses } from './process-reap.js';
import { withRunTransition } from './transition-coordinator.js';

const stoppingSlots = new Set<string>();

const idleDevServers = new IdleDevServerReaper({
  now: () => Date.now(),
  row: readSlotRow,
  runs: () => listRuns({ limit: RUN_LIST_UNLIMITED }).runs,
  progress: async (run) => (await readRunProgress(run)).kind,
  preparing: (slotId) => activePrepareSlots.has(slotId) && !stoppingSlots.has(slotId),
  retained: async (slotId, resourceId) => {
    const status = await getRuntimeCapabilityRegistry().settledStatus(slotId);
    return status.leases.some((lease) => {
      if (lease.state === 'released' && !lease.keepWarmUntil && !lease.providerCleanupDeferred)
        return false;
      const entry = status.catalog.find((entry) => entry.id === lease.capabilityId);
      if (!entry) return true; // A removed provider with surviving ownership is still protected.
      if (entry.affectedResources)
        return entry.affectedResources.some((claim) => claim.resourceId === resourceId);
      const actions = Object.values(entry.actions);
      // Legacy slot actions have no declared resource mapping; guessing could stop another owner.
      return actions.some(
        (action) =>
          action.kind === 'slot-action' ||
          (action.kind === 'resource' && action.resourceId === resourceId),
      );
    });
  },
  resources: resolveSlotResources,
  pointer: async (slotId, resourceId, refresh) => {
    const cached = getActiveResource(slotId, resourceId);
    if (cached && !refresh) return cached;
    const resource = (await resolveSlotResources(slotId)).find(
      (resource) => resource.id === resourceId,
    );
    if (resource?.definition.watch?.type !== 'port-listen') return cached;
    const vars = await loadSlotVars(slotId);
    const project = await loadProjectVars(vars.projectName);
    const port = Number(
      expandTemplate(String(resource.definition.watch.port ?? ''), vars, project),
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    // Port watches intentionally use cheap connect probes. Resolve their exact
    // listener only on idle admission and before cleanup, never every watch tick.
    const result = await execOnSlot(vars, `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      cwd: '/',
      timeout: 5_000,
    });
    if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
    if (result.exitCode !== 0) throw new Error('Idle dev server listener identity unavailable');
    const pids = [...new Set(result.stdout.trim().split(/\s+/).map(Number))];
    if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) return undefined;
    const pointer = {
      pid: pids[0],
      startedAt: cached?.startedAt ?? new Date().toISOString(),
      runId: cached?.runId ?? null,
    };
    setActiveResource(slotId, resourceId, pointer);
    return pointer;
  },
  census: async (slotId) => {
    const result = await execOnSlot(
      await loadSlotVars(slotId),
      'ps -axo pid=,ppid=,pgid=,lstart=,comm=',
      { cwd: '/', timeout: 5_000 },
    );
    if (result.exitCode !== 0) throw new Error('Idle dev server process census unavailable');
    return parseProcessCensus(result.stdout);
  },
  write: async (slotId, expected, fields) =>
    (
      await markSlotStatusIf(
        slotId,
        (row) =>
          row.slot_epoch === expected.slot_epoch &&
          row.current_run_id === expected.current_run_id &&
          row.phase !== 'releasing' &&
          !row.handoff_run_id,
        fields,
      )
    ).applied,
  stop: async (slotId, rows, roots, stillOwned) => {
    if (!(await stillOwned()) || activePrepareSlots.has(slotId)) return false;
    const vars = await loadSlotVars(slotId);
    const panes = await execOnSlot(
      vars,
      tmuxShellSnippet(
        "list-panes -a -F '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{session_path}'",
      ),
      { cwd: '/', timeout: 5_000 },
    );
    const noTmuxServer =
      panes.exitCode === 1 &&
      !panes.stdout.trim() &&
      !rows.some((row) => isTmuxProcess(row.command));
    if (panes.exitCode !== 0 && !noTmuxServer)
      throw new Error('Idle dev server worker census unavailable');
    const session = noTmuxServer ? null : await resolveTmuxSession(slotId, vars, { strict: true });
    const repo = (await slotRealpath(vars, vars.remoteRepo)).replace(/\/$/, '');
    const recorded = new Set(
      listRuns({ limit: RUN_LIST_UNLIMITED })
        .runs.filter((run) => run.slotId === slotId)
        .flatMap((run) =>
          (run.agentContexts ?? []).flatMap((context) =>
            context.target ? [contextPaneId(context.target)] : [],
          ),
        ),
    );
    for (const line of panes.stdout.split('\n')) {
      const [paneSession, paneId, panePid, cwd, origin] = line.split('\t');
      if (
        (paneSession === session ||
          (cwd && isWithinPath(repo, cwd)) ||
          (origin && isWithinPath(repo, origin))) &&
        !recorded.has(paneId) &&
        (await probeRunnerDescendantPid(vars, panePid)).state !== 'absent'
      )
        return false;
    }
    if (!(await stillOwned()) || activePrepareSlots.has(slotId)) return false;
    // Synchronous exclusion uses prepare's existing admission guard while signals run.
    stoppingSlots.add(slotId);
    activePrepareSlots.add(slotId);
    try {
      const result = await reapIdentifiedSlotProcesses(await loadSlotVars(slotId), rows, roots, {
        stillOwned,
      });
      if (!result) return false;
      if (result.survivors.length) throw new Error('Idle dev server process survived cleanup');
      for (const resource of await resolveSlotResources(slotId)) {
        if (
          roots.some((root) => Number(root.pid) === getActiveResource(slotId, resource.id)?.pid)
        ) {
          reportSlotResourceLifecycle({
            slotId,
            resourceId: resource.id,
            action: 'shutdown',
            ok: true,
            detail: 'Dev server idle limit reached',
          });
          deleteActiveResource(slotId, resource.id);
          setCachedResourceStatus(slotId, resource.id, 'stopped');
        }
      }
      return true;
    } finally {
      stoppingSlots.delete(slotId);
      activePrepareSlots.delete(slotId);
    }
  },
  boot: (slotId, resourceId) => executeResourceControl(slotId, resourceId, 'boot'),
  health: async (slotId, resourceId) => (await probeResourceStatus(slotId, resourceId)).status,
});

/** Runs on the resource poll, serialized with run resume and machine parking. */
export async function reapIdleDevServers(slotId: string): Promise<void> {
  const owner = (await readSlotRow(slotId))?.current_run_id;
  if (typeof owner === 'string') await withRunTransition(owner, () => idleDevServers.sweep(slotId));
  else await idleDevServers.sweep(slotId);
}

/** Callers already own the run/machine transition; no reentrant lock. */
export async function restoreIdleDevServers(slotId: string, runId: string): Promise<void> {
  const row = await readSlotRow(slotId);
  if (!row || row.idle_devserver_epoch !== row.slot_epoch || !Array.isArray(row.idle_devservers))
    return;
  if (activePrepareSlots.has(slotId))
    throw new Error('Slot is preparing or stopping its idle dev server; retry resume');
  const controller = new AbortController();
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  activePrepareSlots.add(slotId);
  activePrepareAborts.set(slotId, { abort: () => controller.abort(), settled });
  try {
    await withCleanupSignal(controller.signal, () => idleDevServers.restore(slotId, runId));
  } finally {
    activePrepareSlots.delete(slotId);
    activePrepareAborts.delete(slotId);
    settle();
  }
}
