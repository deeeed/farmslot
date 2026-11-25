import { isTerminalRunStatus, type SlotStatus } from '@farmslot/protocol';

import { withCleanupSignal } from '../core/cleanup-scope.js';
import { loadProjectVars, loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { activePrepareSlots } from '../core/native-worker-exclusion.js';
import { reportSlotResourceLifecycle } from '../core/resource-lifecycle-log.js';
import { slotRealpath } from '../core/slot-io.js';
import {
  markSlotStatusIf,
  readSlotRow,
  sameSlotField,
  SLOT_RELEASE_GATEWAY_INSTANCE,
  SLOT_RELEASING_SINCE,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../core/state.js';
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
import {
  prepareIdentityPath,
  readRecordedPrepareScope,
  reapSlotPrepareScope,
  resolvePrepareRuntimeDir,
} from '../methods/slot/prepare-command.js';
import { activePrepareAborts } from '../methods/slot/shared.js';
import { readRunProgress } from '../runners/run-progress.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';
import { contextPaneId } from '../runners/session-record.js';
import { getAllRuns } from '../runs/store.js';

import {
  DEVSERVER_IDLE_LIMIT_MS,
  type IdleDevServerPointer,
  IdleDevServerReaper,
  type SlotRow,
  slotWorkerRuns,
  WARM_DEVSERVER_IDLE_LIMIT_MS,
} from './idle-devserver.js';
import {
  isTmuxProcess,
  isWithinPath,
  parseLsofNames,
  parseProcessCensus,
  type ProcessCensusRow,
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

/** Whether a capability lease keeps `resourceId`, or any resource of the slot when omitted. */
async function capabilityRetains(slotId: string, resourceId?: string): Promise<boolean> {
  const status = await getRuntimeCapabilityRegistry().settledStatus(slotId);
  return status.leases.some((lease) => {
    if (lease.state === 'released' && !lease.keepWarmUntil && !lease.providerCleanupDeferred)
      return false;
    if (resourceId === undefined) return true;
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
}

async function slotProcessCensus(slotId: string): Promise<ProcessCensusRow[]> {
  const result = await execOnSlot(
    await loadSlotVars(slotId),
    'ps -axo pid=,ppid=,pgid=,lstart=,comm=',
    { cwd: '/', timeout: 5_000 },
  );
  if (result.exitCode !== 0) throw new Error('Idle dev server process census unavailable');
  return parseProcessCensus(result.stdout);
}

/** A tmux pane in the slot's session or checkout that may hold a worker no run records. */
async function unrecordedWorkerPane(
  slotId: string,
  vars: SlotVars,
  rows: ProcessCensusRow[],
  owner: unknown,
): Promise<string | null> {
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
    panes.exitCode === 1 && !panes.stdout.trim() && !rows.some((row) => isTmuxProcess(row.command));
  if (panes.exitCode !== 0 && !noTmuxServer)
    throw new Error('Idle dev server worker census unavailable');
  const session = noTmuxServer ? null : await resolveTmuxSession(slotId, vars, { strict: true });
  const repo = (await slotRealpath(vars, vars.remoteRepo)).replace(/\/$/, '');
  const recorded = new Set(
    slotWorkerRuns(getAllRuns(), slotId, owner).flatMap((run) =>
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
  return null;
}

const idleDevServers = new IdleDevServerReaper({
  now: () => Date.now(),
  row: readSlotRow,
  runs: () => getAllRuns(),
  observed: resourceObservationLosses,
  progress: async (run) => (await readRunProgress(run)).kind,
  preparing: (slotId) => activePrepareSlots.has(slotId) && !stoppingSlots.has(slotId),
  retained: capabilityRetains,
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
  census: slotProcessCensus,
  write: async (slotId, expected, fields, admit) =>
    (
      await markSlotStatusIf(
        slotId,
        (row) =>
          row.slot_epoch === expected.slot_epoch &&
          sameSlotField(row.current_run_id, expected.current_run_id) &&
          row.phase !== 'releasing' &&
          sameSlotField(row.handoff_run_id, expected.handoff_run_id) &&
          (admit?.() ?? true),
        fields,
      )
    ).applied,
  stop: async (slotId, rows, roots, stillOwned) => {
    if (!(await stillOwned()) || activePrepareSlots.has(slotId))
      return 'ownership changed or the slot is preparing';
    const vars = await loadSlotVars(slotId);
    const currentOwner = (await readSlotRow(slotId))?.current_run_id;
    const pane = await unrecordedWorkerPane(slotId, vars, rows, currentOwner);
    if (pane) return pane;
    // Read before any signal: the scope this server ran in, fenced at its stop below.
    const identityPath = prepareIdentityPath(
      vars.remoteRepo,
      await resolvePrepareRuntimeDir(vars.projectName),
    );
    const scopeBefore = currentOwner
      ? undefined
      : await readRecordedPrepareScope(vars, identityPath);
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
      // No run owns the slot, so nothing else ends the preflight scope that kept this server
      // (its holders, log tail and recipe providers). It stops only when the slot is still
      // quiet, no other dev server is up and no lease holds it, fenced to the scope read above.
      if (scopeBefore) {
        const row = await readSlotRow(slotId);
        const kept = row
          ? (scopeQuietBlocker(row, slotId, liveRunSlots()) ??
            (await devServersBlocker(slotId))?.reason)
          : 'slot row unavailable';
        if (kept) logDecision(slotId, undefined, `kept prepare scope: ${kept}`);
        else if (row) await stopPrepareScope(slotId, vars, identityPath, scopeBefore, row, true);
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

/** Slot-row field holding when the sweep first saw a run-less prepare scope: survives restarts. */
const IDLE_SCOPE_FIELD = 'idle_prepare_scope';
interface IdleScope {
  scope: string;
  epoch: unknown;
  since: number;
}

function idleScopeOf(row: SlotRow): IdleScope | null {
  const value = row[IDLE_SCOPE_FIELD];
  if (!value || typeof value !== 'object') return null;
  const scope = Reflect.get(value, 'scope');
  const since = Reflect.get(value, 'since');
  return typeof scope === 'string' && typeof since === 'number'
    ? { scope, since, epoch: Reflect.get(value, 'epoch') }
    : null;
}

/** Slots any non-terminal run names: built once per pass, not per slot. */
function liveRunSlots(): Set<string> {
  return new Set(
    getAllRuns().flatMap((run) =>
      run.slotId && !isTerminalRunStatus(run.status) ? [run.slotId] : [],
    ),
  );
}

/**
 * Why a slot's prepare scope is not idle: the slot must be ready, with no owner, cleanup,
 * handoff, recovery, working agent or live run. The callers hold or check prepare's guard.
 */
function scopeQuietBlocker(row: SlotRow, slotId: string, live: Set<string>): string | null {
  if (row.lifecycle !== 'ready') return `slot ${String(row.lifecycle)}`;
  if (row.phase === 'releasing') return 'slot releasing';
  if (row.current_run_id || row.cleanup_run_id || row.handoff_run_id || row.workspace_recovery)
    return 'slot owned';
  if (row.agent === 'working') return 'slot agent working';
  if (live.has(slotId)) return 'slot has a live run';
  return null;
}

/**
 * A dev server not definitely stopped, or a lease on the slot. `definite` is false for a status
 * not yet reported (a restart or node reconnect): that blocks a stop but keeps a timed window.
 */
async function devServersBlocker(
  slotId: string,
): Promise<{ reason: string; definite: boolean } | null> {
  for (const resource of await resolveSlotResources(slotId))
    if (resource.definition.type === 'dev-server' && resource.status !== 'stopped')
      return {
        reason: `dev server ${resource.id} ${resource.status}`,
        definite: resource.status !== 'unknown',
      };
  return (await capabilityRetains(slotId))
    ? { reason: 'retained by a capability lease', definite: true }
    : null;
}

/**
 * Stop the slot's recorded prepare scope `scope` under the upkeep fence parked-work retention
 * uses: prepare's guard plus a releasing mark on the same ready, ownerless epoch, restored after.
 * A stopped scope also clears `warm`: nothing is left warm. The dev-server stop already holds
 * the guard (`guardHeld`).
 */
async function stopPrepareScope(
  slotId: string,
  vars: SlotVars,
  identityPath: string,
  scope: string,
  row: SlotRow,
  guardHeld: boolean,
): Promise<boolean> {
  if (!guardHeld) {
    if (activePrepareSlots.has(slotId)) return false;
    activePrepareSlots.add(slotId);
  }
  let claimed = false;
  let stopped = false;
  // A reap that threw keeps the window, so the next pass retries it.
  let settled = false;
  const free = (current: SlotRow) =>
    current.slot_epoch === row.slot_epoch &&
    !current.current_run_id &&
    !current.cleanup_run_id &&
    !current.handoff_run_id &&
    !current.workspace_recovery;
  try {
    const mark = await markSlotStatusIf(
      slotId,
      (current) => free(current) && current.lifecycle === 'ready' && current.phase !== 'releasing',
      slotReleasingFenceFields(),
    );
    if (!mark.applied) return false;
    claimed = true;
    stopped = await reapSlotPrepareScope(vars, { identityPath, expectedScope: scope });
    settled = true;
    return stopped;
  } finally {
    // Free the guard before the slot reads ready again, so a claim right after can prepare.
    if (!guardHeld) activePrepareSlots.delete(slotId);
    if (claimed)
      await updateSlotStatusIf(
        slotId,
        (current) => free(current) && current.phase === 'releasing',
        {
          lifecycle: row.lifecycle,
          phase: row.phase,
          [SLOT_RELEASING_SINCE]: null,
          [SLOT_RELEASE_GATEWAY_INSTANCE]: null,
          ...(settled ? { [IDLE_SCOPE_FIELD]: null } : {}),
          ...(stopped ? { warm: false } : {}),
        },
      );
  }
}

interface ScopeCandidate {
  slotId: string;
  row: SlotRow;
  vars: SlotVars;
  identityPath: string;
}

/** Each slot's recorded scope token, one command per machine. */
async function recordedScopes(group: ScopeCandidate[]): Promise<Map<string, string>> {
  const paths = group.map((entry) => shellQuote(entry.identityPath)).join(' ');
  const result = await execOnSlot(
    group[0]!.vars,
    `for f in ${paths}; do l=$(head -n 1 "$f" 2>/dev/null); printf '%s\t%s\n' "$f" "$l"; done`,
    { cwd: '/', timeout: 10_000 },
  );
  if (result.exitCode !== 0) throw new Error(`identity read failed (exit ${result.exitCode})`);
  const scopes = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    // `<path>\t<pgid>\t<sentinel pid>\t<scope>`, as the prepare wrapper records it.
    const [file, , , scope] = line.split('\t');
    if (file && scope) scopes.set(file, scope);
  }
  return scopes;
}

async function timeScope(entry: ScopeCandidate, scope: string | undefined): Promise<void> {
  const { slotId, row, vars, identityPath } = entry;
  const saved = idleScopeOf(row);
  const sameEpoch = (current: SlotRow) => current.slot_epoch === row.slot_epoch;
  if (!scope) {
    if (saved) await updateSlotStatusIf(slotId, sameEpoch, { [IDLE_SCOPE_FIELD]: null });
    return;
  }
  const limit = row.warm === true ? WARM_DEVSERVER_IDLE_LIMIT_MS : DEVSERVER_IDLE_LIMIT_MS;
  const label = `prepare scope ${scope.slice(0, 8)}`;
  if (!saved || saved.scope !== scope || saved.epoch !== row.slot_epoch) {
    const since = Date.now();
    await updateSlotStatusIf(slotId, (current) => sameEpoch(current) && !current.current_run_id, {
      [IDLE_SCOPE_FIELD]: { scope, epoch: row.slot_epoch, since },
    });
    logDecision(
      slotId,
      undefined,
      `idle: ${label} stops after ${new Date(since + limit).toISOString()}${limit === WARM_DEVSERVER_IDLE_LIMIT_MS ? ' (keep-warm)' : ''}`,
    );
    return;
  }
  if (Date.now() - saved.since < limit) return;
  const pane = await unrecordedWorkerPane(slotId, vars, await slotProcessCensus(slotId), null);
  if (pane) {
    // A worker may still use it: start a fresh window instead of re-running both censuses
    // every sweep.
    await updateSlotStatusIf(slotId, sameEpoch, {
      [IDLE_SCOPE_FIELD]: { scope, epoch: row.slot_epoch, since: Date.now() },
    });
    logDecision(slotId, undefined, `skip ${label} stop: ${pane}; window restarted`);
    return;
  }
  const current = await readSlotRow(slotId);
  const late =
    !current || !sameEpoch(current)
      ? 'slot epoch changed'
      : (scopeQuietBlocker(current, slotId, liveRunSlots()) ??
        (await devServersBlocker(slotId))?.reason);
  if (late || !current) {
    logDecision(slotId, undefined, `skip ${label} stop: ${late}`);
    return;
  }
  const stopped = await stopPrepareScope(slotId, vars, identityPath, scope, current, false);
  logDecision(
    slotId,
    undefined,
    stopped ? `stopped idle ${label} with no run` : `${label}: nothing left to stop`,
  );
}

/**
 * Once per idle sweep, for every slot: a prepare scope that outlived its dev server on a quiet,
 * ownerless slot (mini-mmt-3 kept one for two days) stops after the dev-server idle window
 * (2 h on a keep-warm slot), timed from the slot row. Local checks first; then one identity
 * read per machine. Ghost, misconfigured and offline slots are skipped. Only definite activity
 * clears a timed window. Per-slot and per-machine failures are collected and warned each pass,
 * so one slot's failure neither hides another's stop nor goes quiet after its first report.
 */
export async function reapIdlePrepareScopes(
  slots: ReadonlyArray<
    Pick<SlotStatus, 'slot' | 'machine' | 'missingFromPool' | 'configError' | 'health'>
  >,
): Promise<void> {
  const live = liveRunSlots();
  const byMachine = new Map<string, ScopeCandidate[]>();
  const failures: string[] = [];
  for (const slot of slots) {
    if (slot.missingFromPool || slot.configError || slot.health?.ssh === 'FAIL') continue;
    const slotId = slot.slot;
    try {
      const row = await readSlotRow(slotId);
      if (!row) continue;
      const quiet = scopeQuietBlocker(row, slotId, live);
      const servers = quiet || activePrepareSlots.has(slotId) ? null : await devServersBlocker(slotId);
      if (quiet || activePrepareSlots.has(slotId) || servers) {
        // A prepare or an unreported status says nothing about the scope: keep its window.
        if ((quiet || servers?.definite) && idleScopeOf(row))
          await updateSlotStatusIf(slotId, (current) => current.slot_epoch === row.slot_epoch, {
            [IDLE_SCOPE_FIELD]: null,
          });
        continue;
      }
      const vars = await loadSlotVars(slotId);
      const identityPath = prepareIdentityPath(
        vars.remoteRepo,
        await resolvePrepareRuntimeDir(vars.projectName),
      );
      const group = byMachine.get(slot.machine) ?? [];
      group.push({ slotId, row, vars, identityPath });
      byMachine.set(slot.machine, group);
    } catch (error) {
      failures.push(`${slotId}: ${(error as Error).message}`);
    }
  }
  for (const [machine, group] of byMachine) {
    let scopes: Map<string, string>;
    try {
      scopes = await recordedScopes(group);
    } catch (error) {
      // An unreachable machine: its slots wait for the next pass, their windows still recorded.
      failures.push(`${machine}: ${(error as Error).message}`);
      continue;
    }
    for (const entry of group) {
      try {
        await timeScope(entry, scopes.get(entry.identityPath));
      } catch (error) {
        // A failed stop leaves its window in place, so the next pass retries it.
        failures.push(`${entry.slotId}: ${(error as Error).message}`);
      }
    }
  }
  if (failures.length)
    console.warn(
      `[idle-devserver] ${failures.length} prepare-scope check(s) failed: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? `; +${failures.length - 5} more` : ''}`,
    );
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
export async function restoreIdleDevServers(
  slotId: string,
  runId: string,
  admits?: (row: Readonly<Record<string, unknown>>) => boolean,
): Promise<void> {
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
    await withCleanupSignal(controller.signal, () => idleDevServers.restore(slotId, runId, admits));
  } finally {
    activePrepareSlots.delete(slotId);
    activePrepareAborts.delete(slotId);
    settle();
  }
}
