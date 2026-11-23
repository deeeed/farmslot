import { withCleanupSignal } from '../core/cleanup-scope.js';
import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { activePrepareSlots } from '../core/native-worker-exclusion.js';
import { reportSlotResourceLifecycle } from '../core/resource-lifecycle-log.js';
import { slotRealpath } from '../core/slot-io.js';
import { markSlotStatusIf, readSlotRow } from '../core/state.js';
import {
  resolveTmuxSession,
  shellQuote,
  splitTmuxFields,
  tmuxFieldFormat,
  tmuxShellSnippet,
} from '../core/tmux.js';
import {
  deleteActiveResource,
  getActiveResource,
  resolveSlotResources,
  resourceObservationLosses,
  setCachedResourceStatus,
} from '../fleet/resource-manager.js';
import { probeResourceProcess } from '../fleet/resource-process.js';
import { ensureResourceReady } from '../fleet/runtime-ready.js';
import { getRuntimeCapabilityRegistry } from '../methods/runtime-capabilities.js';
import { activePrepareAborts } from '../methods/slot/shared.js';
import { readRunProgress } from '../runners/run-progress.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';
import { contextPaneId } from '../runners/session-record.js';
import { getAllRuns } from '../runs/store.js';

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

/** `ps -o etime` as seconds: `[[dd-]hh:]mm:ss`. */
export function elapsedSeconds(etime: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return undefined;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

// Write-order and whole-second slack between a launch and its PID-file write.
const PID_FILE_WRITE_SLACK_S = 2;

/** Read a PID file's PID, its age, and that process's elapsed time and start, in one call. */
export function pidFileProbeCommand(pidPath: string): string {
  return [
    `f=${shellQuote(pidPath)}`,
    '[ -f "$f" ] || exit 3',
    // Exactly one non-empty line holding one decimal PID.
    '[ "$(grep -c . "$f" 2>/dev/null)" = 1 ] || exit 3',
    'pid=$(grep . "$f" | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")',
    'case "$pid" in ""|*[!0-9]*) exit 3 ;; esac',
    // BSD stat first; GNU `stat -f` prints filesystem details, so each result is validated.
    'modified=$(stat -f %m "$f" 2>/dev/null)',
    'case "$modified" in ""|*[!0-9]*) modified=$(stat -c %Y "$f" 2>/dev/null) ;; esac',
    'case "$modified" in ""|*[!0-9]*) exit 3 ;; esac',
    // One ps record, so the elapsed time and start time belong to the same process.
    'record=$(ps -o etime=,lstart= -p "$pid" 2>/dev/null)',
    '[ -n "$record" ] || exit 3',
    'echo "$pid $(( $(date +%s) - modified )) $record"',
  ].join('\n');
}

/**
 * The process a PID file names, only while it already existed when the file was written: a
 * reused PID starts after a stale file and grants nothing. Its start time binds the later
 * identity probe to the same incarnation.
 */
export function parsePidFileProbe(stdout: string): { pid: number; identity: string } | undefined {
  const [pidText = '', ageText = '', etime = '', ...started] = stdout.trim().split(/\s+/);
  const pid = Number(pidText);
  const fileAge = Number(ageText);
  const running = elapsedSeconds(etime);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isFinite(fileAge) ||
    running === undefined ||
    !started.length ||
    running + PID_FILE_WRITE_SLACK_S < fileAge
  )
    return undefined;
  return { pid, identity: started.join(' ') };
}

/** Whether a process in this group listens on the port: the resource it serves. */
async function groupHoldsListener(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  port: number,
  group: number,
): Promise<boolean> {
  const result = await execOnSlot(
    vars,
    `for p in $(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null); do ps -o pgid= -p "$p" 2>/dev/null; done`,
    { cwd: '/', timeout: 5_000 },
  );
  if (result.exitCode !== 0) throw new Error('Idle dev server listener identity unavailable');
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .some((value) => Number(value) === group);
}

async function recordedPidFileProcess(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  pidPath: string,
): Promise<{ pid: number; identity: string } | undefined> {
  const result = await execOnSlot(vars, pidFileProbeCommand(pidPath), { cwd: '/', timeout: 5_000 });
  if (result.exitCode === 3) return undefined;
  if (result.exitCode !== 0) throw new Error('Idle dev server PID file unavailable');
  return parsePidFileProbe(result.stdout);
}

// Why the latest pointer call for a slot resource returned nothing (read once), and the last
// decision logged for it: the idle cap logs a structured line only when its decision changes.
const idleReasons = new Map<string, string>();
const loggedDecisions = new Map<string, string>();

function because(slotId: string, resourceId: string, reason: string): undefined {
  idleReasons.set(`${slotId}/${resourceId}`, reason);
  return undefined;
}

function logDecision(slotId: string, resourceId: string | undefined, decision: string): void {
  const key = `${slotId}/${resourceId ?? '-'}`;
  if (loggedDecisions.get(key) === decision) return;
  loggedDecisions.set(key, decision);
  console.info(
    `[idle-devserver] slot=${slotId} resource=${resourceId ?? '-'} decision=${decision}`,
  );
}

const stoppingSlots = new Set<string>();
interface OwnedListener extends IdleDevServerPointer {
  epoch: unknown;
}
const ownedListeners = new Map<string, OwnedListener>();

const idleDevServers = new IdleDevServerReaper({
  now: () => Date.now(),
  row: readSlotRow,
  runs: () => getAllRuns(),
  observed: resourceObservationLosses,
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
  decide: logDecision,
  explain: (slotId, resourceId) => {
    const key = `${slotId}/${resourceId}`;
    const reason = idleReasons.get(key);
    idleReasons.delete(key);
    return reason;
  },
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
    const launch = cached?.meta?.slotId === slotId ? cached.meta.process : undefined;
    let recordedIdentity: string | undefined;
    let servedPort: number | undefined;
    if (resource?.definition.watch?.type === 'port-listen') {
      const project = await loadProjectVars(vars.projectName);
      const port = Number(
        expandTemplate(String(resource.definition.watch.port ?? ''), vars, project),
      );
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return because(slotId, resourceId, 'watched port is not configured');
      const result = await execOnSlot(vars, `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
        cwd: '/',
        timeout: 5_000,
      });
      if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim())
        return because(slotId, resourceId, `nothing listens on port ${port}`);
      if (result.exitCode !== 0) throw new Error('Idle dev server listener identity unavailable');
      const pids = [...new Set(result.stdout.trim().split(/\s+/).map(Number))];
      if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0)
        return because(slotId, resourceId, `port ${port} has ${pids.length} listeners`);
      pid = pids[0];
    } else if (
      resource?.definition.watch?.type === 'pid-file' &&
      resource.definition.watch.port &&
      !launch
    ) {
      // A watch that declares the port it serves: without this gateway's launch record (a
      // restart, or a watcher that rebuilt the cache from liveness alone) the watched PID file
      // is the candidate, only while its process predates the file and its group holds the
      // listener. The checkout-cwd provenance below still decides. A watch without a port keeps
      // the cached PID and that provenance alone, as before.
      const watchPath = resource.definition.watch.path;
      if (!watchPath) return because(slotId, resourceId, 'pid-file watch has no path');
      const project = await loadProjectVars(vars.projectName);
      const port = Number(expandTemplate(String(resource.definition.watch.port), vars, project));
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return because(slotId, resourceId, 'declared watch port is not configured');
      const expanded = expandTemplate(String(watchPath), vars, project);
      const pidPath = expanded.startsWith('/') ? expanded : `${vars.remoteRepo}/${expanded}`;
      const recorded = await recordedPidFileProcess(vars, pidPath);
      if (!recorded)
        return because(slotId, resourceId, 'PID file missing, invalid or older than its process');
      if (cached?.pid !== undefined && cached.pid !== recorded.pid)
        return because(
          slotId,
          resourceId,
          `cached pid ${cached.pid} differs from PID file pid ${recorded.pid}`,
        );
      pid = recorded.pid;
      recordedIdentity = recorded.identity;
      servedPort = port;
    }
    if (!pid)
      return because(
        slotId,
        resourceId,
        launch ? 'launch record has no pid' : 'no cached pid and no PID-file fallback',
      );
    const process = await probeResourceProcess(vars, pid);
    if (!process) return because(slotId, resourceId, `pid ${pid} is not running`);
    if (
      recordedIdentity !== undefined &&
      process.identity !== recordedIdentity.replace(/\s+/g, ' ')
    )
      return because(slotId, resourceId, `pid ${pid} is not the process the PID file recorded`);
    if (servedPort !== undefined && !(await groupHoldsListener(vars, servedPort, process.group)))
      return because(
        slotId,
        resourceId,
        `process group ${process.group} does not hold port ${servedPort}`,
      );
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
        return because(slotId, resourceId, `pid ${pid} runs outside the slot checkout`);
      }
      const after = await probeResourceProcess(vars, pid);
      if (!after || !matches(after))
        return because(slotId, resourceId, `pid ${pid} changed during provenance checks`);
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
  write: async (slotId, expected, fields, admit) =>
    (
      await markSlotStatusIf(
        slotId,
        (row) =>
          row.slot_epoch === expected.slot_epoch &&
          row.current_run_id === expected.current_run_id &&
          row.phase !== 'releasing' &&
          (row.handoff_run_id ?? null) === (expected.handoff_run_id ?? null) &&
          (admit?.() ?? true),
        fields,
      )
    ).applied,
  stop: async (slotId, rows, roots, stillOwned) => {
    if (!(await stillOwned()) || activePrepareSlots.has(slotId))
      return 'ownership changed or the slot is preparing';
    const vars = await loadSlotVars(slotId);
    const panes = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -a -F '${tmuxFieldFormat(
          '#{session_name}',
          '#{pane_id}',
          '#{pane_pid}',
          '#{pane_current_path}',
          '#{session_path}',
        )}'`,
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
      slotWorkerRuns(getAllRuns(), slotId, currentOwner).flatMap((run) =>
        (run.agentContexts ?? []).flatMap((context) =>
          context.target ? [contextPaneId(context.target)] : [],
        ),
      ),
    );
    for (const line of panes.stdout.split('\n')) {
      const [paneSession, paneId, panePid, cwd, origin] = splitTmuxFields(line, 5);
      if (
        (paneSession === session ||
          (cwd && isWithinPath(repo, cwd)) ||
          (origin && isWithinPath(repo, origin))) &&
        !recorded.has(paneId) &&
        (await probeRunnerDescendantPid(vars, panePid)).state !== 'absent'
      )
        return `pane ${paneId} may hold an unrecorded worker`;
    }
    if (!(await stillOwned()) || activePrepareSlots.has(slotId))
      return 'ownership changed or the slot is preparing';
    // Synchronous exclusion uses prepare's existing admission guard while signals run.
    stoppingSlots.add(slotId);
    activePrepareSlots.add(slotId);
    try {
      const result = await reapIdentifiedSlotProcesses(await loadSlotVars(slotId), rows, roots, {
        stillOwned,
      });
      if (!result) return 'the process reap declined';
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

/** The idle sweep stopped observing this slot: no idle window carries over. */
export function forgetIdleDevServers(slotId: string): void {
  idleDevServers.forget(slotId);
}

/** Runs on the idle sweep, serialized with run resume and machine parking. */
export async function reapIdleDevServers(slotId: string): Promise<void> {
  // No quiet checks or transition lock for a slot without a dev server the cap may stop.
  if (!(await idleDevServers.eligible(slotId)).length) return;
  const owner = (await readSlotRow(slotId))?.current_run_id;
  if (typeof owner !== 'string') return idleDevServers.sweep(slotId);
  const swept = await tryWithRunTransition(owner, async () => {
    await idleDevServers.sweep(slotId);
    return true;
  });
  if (!swept) logDecision(slotId, undefined, 'skip: run transition in progress');
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
