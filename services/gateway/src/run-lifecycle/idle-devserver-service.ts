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
  getActiveResource,
  resolveSlotResources,
  setCachedResourceStatus,
} from '../fleet/resource-manager.js';
import { probeResourceProcess } from '../fleet/resource-process.js';
import { ensureResourceReady } from '../fleet/runtime-ready.js';
import { getRuntimeCapabilityRegistry } from '../methods/runtime-capabilities.js';
import { activePrepareAborts } from '../methods/slot/shared.js';
import { readRunProgress } from '../runners/run-progress.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';
import { contextPaneId } from '../runners/session-record.js';
import { listRuns } from '../runs/store.js';

import {
  type IdleDevServerPointer,
  IdleDevServerReaper,
  slotWorkerRuns,
} from './idle-devserver.js';
import {
  isTmuxProcess,
  isWithinPath,
  parseLsofNames,
  parseProcessCensus,
} from './process-census.js';
import { reapIdentifiedSlotProcesses } from './process-reap.js';
import { tryWithRunTransition } from './transition-coordinator.js';

const stoppingSlots = new Set<string>();
interface OwnedListener extends IdleDevServerPointer {
  epoch: unknown;
}
const ownedListeners = new Map<string, OwnedListener>();

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
    const key = `${slotId}/${resourceId}`;
    const epoch = (await readSlotRow(slotId))?.slot_epoch;
    const saved = ownedListeners.get(key);
    const retained = saved?.epoch === epoch ? saved : undefined;
    if (retained && !refresh) return retained;
    const cached = getActiveResource(slotId, resourceId);
    const vars = await loadSlotVars(slotId);
    const resource = (await resolveSlotResources(slotId)).find(
      (resource) => resource.id === resourceId,
    );
    let pid = cached?.pid;
    if (resource?.definition.watch?.type === 'port-listen') {
      const project = await loadProjectVars(vars.projectName);
      const port = Number(
        expandTemplate(String(resource.definition.watch.port ?? ''), vars, project),
      );
      if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
      const result = await execOnSlot(vars, `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
        cwd: '/',
        timeout: 5_000,
      });
      if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
      if (result.exitCode !== 0) throw new Error('Idle dev server listener identity unavailable');
      const pids = [...new Set(result.stdout.trim().split(/\s+/).map(Number))];
      if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) return undefined;
      pid = pids[0];
    }
    if (!pid) return undefined;
    const process = await probeResourceProcess(vars, pid);
    if (!process) return undefined;
    const launch = cached?.meta?.slotId === slotId ? cached.meta.process : undefined;
    const matches = (known: IdleDevServerPointer | undefined) =>
      known &&
      known.pid === pid &&
      known.identity === process.identity &&
      known.group === process.group;
    if (!matches(launch) && !matches(retained)) {
      // A listener alone grants no authority. A checkout cwd is independent slot
      // provenance for legacy prepare hooks that don't retain launch metadata.
      const repo = await slotRealpath(vars, vars.remoteRepo);
      const cwd = await execOnSlot(vars, `lsof -a -p ${pid} -d cwd -Fn`, {
        cwd: '/',
        timeout: 5_000,
      });
      if (cwd.exitCode !== 0) throw new Error('Idle dev server checkout provenance unavailable');
      const paths = parseLsofNames(cwd.stdout).filter(([owner]) => owner === String(pid));
      if (!paths.some(([, directory]) => isWithinPath(repo.replace(/\/$/, ''), directory))) {
        console.warn(
          `[idle-devserver] ${slotId}/${resourceId}: listener ${pid} has no slot ownership proof; preserving it`,
        );
        return undefined;
      }
      const after = await probeResourceProcess(vars, pid);
      if (!after || !matches(after)) return undefined;
    }
    ownedListeners.set(key, { ...process, epoch });
    return process;
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
          (row.handoff_run_id ?? null) === (expected.handoff_run_id ?? null),
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
    const currentOwner = (await readSlotRow(slotId))?.current_run_id;
    const recorded = new Set(
      slotWorkerRuns(listRuns({ limit: RUN_LIST_UNLIMITED }).runs, slotId, currentOwner).flatMap(
        (run) =>
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
          roots.some(
            (root) => Number(root.pid) === ownedListeners.get(`${slotId}/${resource.id}`)?.pid,
          )
        ) {
          reportSlotResourceLifecycle({
            slotId,
            resourceId: resource.id,
            action: 'shutdown',
            ok: true,
            detail: 'Dev server idle limit reached',
          });
          ownedListeners.delete(`${slotId}/${resource.id}`);
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
  ready: async (slotId, resourceId, runId, assertOwner) => {
    const owner = runId ?? (await readSlotRow(slotId))?.current_run_id;
    if (typeof owner !== 'string') throw new Error('Dev server restore requires an owned slot');
    await ensureResourceReady(slotId, owner, resourceId, assertOwner, assertOwner);
  },
});

/** Runs on the resource poll, serialized with run resume and machine parking. */
export async function reapIdleDevServers(slotId: string): Promise<void> {
  const owner = (await readSlotRow(slotId))?.current_run_id;
  if (typeof owner === 'string')
    await tryWithRunTransition(owner, () => idleDevServers.sweep(slotId));
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
