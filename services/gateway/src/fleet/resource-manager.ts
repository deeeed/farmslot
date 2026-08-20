// resource-manager.ts — resolve slot resources + execute resource control hooks + health polling
// Supports both push-based (agent watches) and pull-based (60s poll reconciliation)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ActiveResourcePointer,
  Events,
  type ResourceControlAction,
  type ResourceDefinition,
  type ResourceRelaunchedPayload,
  type ResourceSidecarMeta,
  type ResourceStateUpdate,
  type ResourceStatus,
  type ResourceStreamStatus,
  type ResourceWatchProvider,
  type ResourceWatchSetEnabledResult,
  type ResourceWatchType,
  type SlotResource,
  type SlotStatus,
} from '@farmslot/protocol';

// ─── Placeholder helpers ───
import { loadProjectVars, loadSlotVars, type RawProjectJson, resolveSlot } from '../core/config.js';
import { execLocal } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { shellQuote } from '../core/tmux.js';
import { farmslotRoot } from '../projects/repo-root.js';

import { getAllNodes, getNode } from './machine-registry.js';
import { getSlotLocality, sendNodeRequest } from './node-rpc.js';
import { getCachedFleet, loadFleetStatus } from './state.js';

export function findUnresolvedPlaceholders(expanded: string): string[] {
  const matches = expanded.match(/\{\{[^}]+\}\}/g);
  return matches ? matches.map((m) => m.slice(2, -2)) : [];
}

export function hasUnresolvedPlaceholders(expanded: string): boolean {
  return /\{\{[^}]+\}\}/.test(expanded);
}

export function isSlotResourceConfigured(
  configuredResources: Record<string, unknown> | undefined,
  resourceId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(configuredResources ?? {}, resourceId);
}

// ─── Status cache ───

// slotId → resourceId → status
const statusCache = new Map<string, Map<string, ResourceStatus>>();
const streamStatusCache = new Map<string, Map<string, ResourceStreamStatus>>();
// slotId → resourceId → ActiveResourcePointer. In-memory only; reconstructs
// from the next `running` events after gateway restart.
const activeResource = new Map<string, Map<string, ActiveResourcePointer>>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((event: string, payload: unknown) => void) | null = null;
const RESOURCE_POLL_CONCURRENCY = 4;
let pollAllInFlight = false;
const warnedUnconfiguredResources = new Map<string, string>();
const loggedLegacySharedProviderInferences = new Set<string>();

export function purgeRemovedSlotWarnings(
  warnings: Map<string, string>,
  activeSlotIds: ReadonlySet<string>,
): void {
  for (const slotId of warnings.keys()) {
    if (!activeSlotIds.has(slotId)) warnings.delete(slotId);
  }
}

// Track which machines have active resource watches
const resourceWatchStateFile =
  process.env.FARMSLOT_RESOURCE_WATCH_STATE_FILE ??
  path.join(farmslotRoot, '.farm-cache', 'resource-watch-state.json');
const persistedResourceWatchState = loadPersistedResourceWatchState();
let resourceWatchAutoStartEnabled =
  readEnvResourceWatchEnabled() ?? persistedResourceWatchState?.enabled ?? true;
let resourceWatchStateUpdatedAt: string | null = persistedResourceWatchState?.updatedAt ?? null;

export function shouldAutoStartResourceWatches(): boolean {
  return resourceWatchAutoStartEnabled;
}

export function getResourceWatchRuntimeState(): { enabled: boolean; updatedAt: string | null } {
  return { enabled: resourceWatchAutoStartEnabled, updatedAt: resourceWatchStateUpdatedAt };
}

function readEnvResourceWatchEnabled(): boolean | undefined {
  if (process.env.FARMSLOT_RESOURCE_WATCHES === undefined) return undefined;
  return (
    process.env.FARMSLOT_RESOURCE_WATCHES !== '0' &&
    process.env.FARMSLOT_RESOURCE_WATCHES !== 'false'
  );
}

function loadPersistedResourceWatchState(): { enabled: boolean; updatedAt: string | null } | null {
  if (!existsSync(resourceWatchStateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(resourceWatchStateFile, 'utf8')) as {
      enabled?: unknown;
      updatedAt?: unknown;
    };
    if (typeof parsed.enabled !== 'boolean') return null;
    return {
      enabled: parsed.enabled,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (err) {
    // Corrupt local runtime state should not prevent the gateway from starting;
    // env/default state remains authoritative until the operator toggles again.
    console.warn(
      `[resource-manager] ignoring invalid resource watch state file: ${(err as Error).message}`,
    );
    return null;
  }
}

function persistResourceWatchState(enabled: boolean, updatedAt: string): void {
  mkdirSync(path.dirname(resourceWatchStateFile), { recursive: true });
  writeFileSync(resourceWatchStateFile, JSON.stringify({ enabled, updatedAt }, null, 2));
}

/**
 * Get cached resource status for a slot+resource. Returns 'unknown' if not cached.
 */
export function getCachedResourceStatus(slotId: string, resourceId: string): ResourceStatus {
  return statusCache.get(slotId)?.get(resourceId) ?? 'unknown';
}

/**
 * Get all cached resource statuses for a slot.
 */
export function getCachedSlotResources(slotId: string): Map<string, ResourceStatus> | undefined {
  return statusCache.get(slotId);
}

// ─── Sticky ActiveResource pointer ───
// Maintained by the gateway so stream/screen consumers rebind across relaunches
// instead of pinning a dead pid captured at subscribe time.

export function getActiveResource(
  slotId: string,
  resourceId: string,
): ActiveResourcePointer | undefined {
  return activeResource.get(slotId)?.get(resourceId);
}

export function getActiveResources(slotId: string): Map<string, ActiveResourcePointer> | undefined {
  return activeResource.get(slotId);
}

export function slotHasActiveRun(slot: Pick<SlotStatus, 'currentRunId' | 'lifecycle'>): boolean {
  return Boolean(slot.currentRunId && (slot.lifecycle === 'busy' || slot.lifecycle === 'held'));
}

export function isSimulatorDeviceProbe(
  resourceDef: Pick<ResourceDefinition, 'type' | 'platform'> & {
    watch?: Pick<NonNullable<ResourceDefinition['watch']>, 'type' | 'cmd' | 'provider'>;
    hooks?: Pick<NonNullable<ResourceDefinition['hooks']>, 'health'>;
  },
): boolean {
  if (resourceDef.type !== 'device' || resourceDef.platform !== 'ios') return false;
  if (resourceDef.watch?.provider === 'ios-simulator-inventory') return true;
  const probeCommand = `${resourceDef.watch?.cmd ?? ''}\n${resourceDef.hooks?.health ?? ''}`;
  return /\bsimctl\b/.test(probeCommand);
}

export function inferSharedProcessPollProvider(
  resourceDef: Pick<ResourceDefinition, 'type' | 'platform'> & {
    watch?: Pick<NonNullable<ResourceDefinition['watch']>, 'type' | 'provider'>;
  },
  expandedCommand: string,
): ResourceWatchProvider | undefined {
  if (resourceDef.watch?.provider) {
    return resourceDef.watch.type === 'process-poll' &&
      resourceDef.type === 'device' &&
      resourceDef.platform === 'ios'
      ? resourceDef.watch.provider
      : undefined;
  }
  if (
    resourceDef.watch?.type === 'process-poll' &&
    resourceDef.type === 'device' &&
    resourceDef.platform === 'ios' &&
    /\bxcrun\s+simctl\s+list\s+devices\s+booted\b/.test(expandedCommand)
  ) {
    // Migration bridge: current project configs already use this canonical
    // command. New configs declare provider explicitly; old nodes ignore the
    // additive provider/target fields and keep executing the command fallback.
    return 'ios-simulator-inventory';
  }
  return undefined;
}

export function shouldProbeResourceForSlot(
  slot: Pick<SlotStatus, 'currentRunId' | 'lifecycle'> | undefined,
  resourceDef: Pick<ResourceDefinition, 'type' | 'platform'> & {
    watch?: Pick<NonNullable<ResourceDefinition['watch']>, 'type' | 'cmd'>;
    hooks?: Pick<NonNullable<ResourceDefinition['hooks']>, 'health'>;
  },
): boolean {
  if (!isSimulatorDeviceProbe(resourceDef)) return true;
  return Boolean(slot && slotHasActiveRun(slot));
}

function setActiveResource(
  slotId: string,
  resourceId: string,
  pointer: ActiveResourcePointer,
): void {
  let slotMap = activeResource.get(slotId);
  if (!slotMap) {
    slotMap = new Map();
    activeResource.set(slotId, slotMap);
  }
  slotMap.set(resourceId, pointer);
}

export function deleteActiveResource(slotId: string, resourceId: string): void {
  const slotMap = activeResource.get(slotId);
  if (!slotMap) return;
  slotMap.delete(resourceId);
  if (slotMap.size === 0) activeResource.delete(slotId);
}

// ─── Relaunch listener registry ───
// Local in-process subscription so consumers like screen-session can rebind
// active capture sessions to the new pid instead of pinning the old one until
// the viewer reconnects. Kept separate from the WS broadcast so we can invoke
// it synchronously before any client-side frame handling runs.
type ResourceRelaunchedListener = (payload: ResourceRelaunchedPayload) => void;
const relaunchListeners = new Set<ResourceRelaunchedListener>();

export function onResourceRelaunched(listener: ResourceRelaunchedListener): () => void {
  relaunchListeners.add(listener);
  return () => {
    relaunchListeners.delete(listener);
  };
}

function emitRelaunched(payload: ResourceRelaunchedPayload): void {
  for (const fn of relaunchListeners) {
    try {
      fn(payload);
    } catch (err) {
      console.warn(`[resource-manager] relaunch listener threw: ${(err as Error).message}`);
    }
  }
}

function getStreamStatusMap(slotId: string): Map<string, ResourceStreamStatus> {
  let slotCache = streamStatusCache.get(slotId);
  if (!slotCache) {
    slotCache = new Map();
    streamStatusCache.set(slotId, slotCache);
  }
  return slotCache;
}

export function getCachedStreamStatus(
  slotId: string,
  resourceId: string,
): ResourceStreamStatus | undefined {
  return streamStatusCache.get(slotId)?.get(resourceId);
}

export function setCachedResourceStatus(
  slotId: string,
  resourceId: string,
  status: ResourceStatus,
  opts?: { broadcast?: boolean },
): void {
  let slotCache = statusCache.get(slotId);
  if (!slotCache) {
    slotCache = new Map();
    statusCache.set(slotId, slotCache);
  }
  const prev = slotCache.get(resourceId);
  if (prev === status) return;
  slotCache.set(resourceId, status);
  if (status !== 'running') {
    resetStreamStateIfInactiveLifecycle(slotId, resourceId, status);
  }
  if (opts?.broadcast !== false) {
    broadcastSlotResources(slotId, [{ id: resourceId, status }]);
  }
}

function buildResourceUpdates(
  slotId: string,
  resources: Array<{ id: string; status: ResourceStatus }>,
): ResourceStateUpdate[] {
  return resources.map((resource) => ({
    ...resource,
    stream: getCachedStreamStatus(slotId, resource.id),
  }));
}

function broadcastSlotResources(
  slotId: string,
  resources: Array<{ id: string; status: ResourceStatus }>,
): void {
  if (!broadcastFn) return;
  broadcastFn('resource.status.updated', {
    slotId,
    resources: buildResourceUpdates(slotId, resources),
  });
}

function resetStreamStateIfInactiveLifecycle(
  slotId: string,
  resourceId: string,
  status: ResourceStatus,
): boolean {
  // `stale` means the process is alive but owned by a different run — the
  // stream/screen feed is still capturable, so preserve state like `running`.
  if (status === 'running' || status === 'stale') return false;
  const slotCache = streamStatusCache.get(slotId);
  if (!slotCache?.has(resourceId)) return false;
  const prev = slotCache.get(resourceId);
  if (prev?.state === 'unknown' && !prev.detail) return false;
  slotCache.set(resourceId, { state: 'unknown', updatedAt: new Date().toISOString() });
  return true;
}

export function setResourceStreamState(
  slotId: string,
  resourceId: string,
  stream: ResourceStreamStatus,
): void {
  const slotCache = getStreamStatusMap(slotId);
  const prev = slotCache.get(resourceId);
  if (prev?.state === stream.state && prev?.detail === stream.detail) return;
  slotCache.set(resourceId, stream);
  const status = getCachedResourceStatus(slotId, resourceId);
  broadcastSlotResources(slotId, [{ id: resourceId, status }]);
}

export function clearResourceStreamState(slotId: string, resourceId: string): void {
  const slotCache = streamStatusCache.get(slotId);
  if (!slotCache?.has(resourceId)) return;
  slotCache.set(resourceId, { state: 'unknown', updatedAt: new Date().toISOString() });
  const status = getCachedResourceStatus(slotId, resourceId);
  broadcastSlotResources(slotId, [{ id: resourceId, status }]);
}

/**
 * Resolve available resources for a slot.
 * Reads definitions from project.json, limited to resources configured by the slot.
 * Uses cached status if available.
 */
export async function resolveSlotResources(slotId: string): Promise<SlotResource[]> {
  const { pool, slot } = await resolveSlot(slotId);
  const projectName = slot.project ?? pool.project;
  const projectVars = await loadProjectVars(projectName);
  const projectJson = projectVars.projectJson;

  if (!projectJson.resources) return [];

  const slotCache = statusCache.get(slotId);
  const streamCache = streamStatusCache.get(slotId);

  const resourceEntries = Object.entries(projectJson.resources);
  const droppedIds = resourceEntries
    .map(([id]) => id)
    .filter((id) => !isSlotResourceConfigured(slot.resources, id));
  const warningSignature = droppedIds.join(',');
  if (droppedIds.length === 0) {
    warnedUnconfiguredResources.delete(slotId);
  } else if (warnedUnconfiguredResources.get(slotId) !== warningSignature) {
    warnedUnconfiguredResources.set(slotId, warningSignature);
    console.warn(
      `[resource-manager] slot ${slotId} does not configure project resource(s): ${droppedIds.join(', ')}`,
    );
  }

  return resourceEntries
    .filter(([id]) => isSlotResourceConfigured(slot.resources, id))
    .map(([id, def]) => ({
      id,
      definition: {
        type: (def.type ?? 'device') as ResourceDefinition['type'],
        platform: def.platform,
        label: def.label ?? id,
        streamable: def.streamable ?? true,
        controllable: def.controllable ?? false,
        watch: def.watch
          ? {
              type: def.watch.type as ResourceWatchType,
              path: def.watch.path,
              port: def.watch.port,
              cmd: def.watch.cmd,
              provider: def.watch.provider,
              target: def.watch.target,
              intervalMs: def.watch.intervalMs,
            }
          : undefined,
        hooks: def.hooks as ResourceDefinition['hooks'],
        actions: def.actions as ResourceDefinition['actions'],
      },
      status: (slotCache?.get(id) ?? 'unknown') as ResourceStatus,
      stream: def.streamable ? (streamCache?.get(id) ?? { state: 'unknown' }) : undefined,
    }));
}

/**
 * Run a resource's health hook. Returns ok:true if healthy or no hook defined.
 * Prefers agent-mediated execution for remote machines.
 */
export async function executeResourceHealth(
  slotId: string,
  resourceId: string,
): Promise<{ ok: boolean; detail?: string }> {
  const { pool, slot } = await resolveSlot(slotId);
  if (!isSlotResourceConfigured(slot.resources, resourceId)) {
    return { ok: false, detail: `Resource '${resourceId}' is not configured for slot '${slotId}'` };
  }
  const projectName = slot.project ?? pool.project;
  const projectVars = await loadProjectVars(projectName);
  const projectJson = projectVars.projectJson;
  const slotVars = await loadSlotVars(slotId);

  const resourceDef = projectJson.resources?.[resourceId];
  if (!resourceDef) {
    return { ok: false, detail: `Resource '${resourceId}' not found in project config` };
  }

  const hookCmd = resourceDef.hooks?.health;
  if (!hookCmd) {
    // No health hook — assume running (can't tell)
    return { ok: true };
  }

  const expanded = expandTemplate(hookCmd, slotVars, projectVars);

  // Skip if required placeholders couldn't be resolved
  if (hasUnresolvedPlaceholders(expanded)) {
    const unresolved = findUnresolvedPlaceholders(expanded);
    return { ok: false, detail: `skipped (${unresolved.join(', ')} not configured)` };
  }

  const result = await execResourceCommand(slotId, slotVars.repo, expanded, 5_000);
  if (result.exitCode === 0) {
    if (resourceDef.type !== 'browser') return { ok: true };
    const capturable = await verifyBrowserPidFileCapturable(
      slotId,
      resourceDef,
      slotVars,
      projectVars,
    );
    if (capturable.ok) return capturable;
  }

  const fallback = await recoverBrowserPidFromCdp(
    slotId,
    resourceId,
    resourceDef,
    slotVars,
    projectVars,
  );
  if (fallback.ok) return fallback;

  if (resourceDef.type === 'browser' && result.exitCode === 0) {
    return { ok: false, detail: 'browser pid is not stream-capturable and CDP recovery failed' };
  }

  return { ok: false, detail: result.stderr?.trim() || `exit ${result.exitCode}` };
}

async function execResourceCommand(
  slotId: string,
  cwd: string,
  cmd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { isLocal, machine } = await getSlotLocality(slotId);
  if (!isLocal) {
    const node = getNode(machine);
    if (node) {
      try {
        return (await sendNodeRequest(node, 'exec', { cmd, cwd, timeout })) as {
          stdout: string;
          stderr: string;
          exitCode: number;
        };
      } catch (err) {
        return { stdout: '', stderr: (err as Error).message, exitCode: 1 };
      }
    }
    // No node — fall through to local exec, matching the legacy health path.
  }

  return execLocal(cmd, { cwd, timeout });
}

async function verifyBrowserPidFileCapturable(
  slotId: string,
  resourceDef: NonNullable<RawProjectJson['resources']>[string],
  slotVars: Awaited<ReturnType<typeof loadSlotVars>>,
  projectVars: Awaited<ReturnType<typeof loadProjectVars>>,
): Promise<{ ok: boolean; detail?: string }> {
  const pidPath = browserPidPath(resourceDef, slotVars, projectVars);
  if (!pidPath) return { ok: false };
  const result = await execResourceCommand(
    slotId,
    slotVars.repo,
    buildBrowserPidFileCapturableCommand(pidPath),
    5_000,
  );
  return result.exitCode === 0 ? { ok: true } : { ok: false };
}

function browserPidPath(
  resourceDef: NonNullable<RawProjectJson['resources']>[string],
  slotVars: Awaited<ReturnType<typeof loadSlotVars>>,
  projectVars: Awaited<ReturnType<typeof loadProjectVars>>,
): string | null {
  const rawPidPath = resourceDef.watch?.path;
  if (!rawPidPath) return null;
  const expandedPidPath = expandTemplate(rawPidPath, slotVars, projectVars);
  if (hasUnresolvedPlaceholders(expandedPidPath)) return null;
  return expandedPidPath.startsWith('/')
    ? expandedPidPath
    : `${slotVars.remoteRepo}/${expandedPidPath}`;
}

export function buildBrowserPidFileCapturableCommand(pidPath: string): string {
  return [
    'set -e',
    buildCaptureHelperResolveFunction(),
    `pid_file=${shellQuote(pidPath)}`,
    'pid="$(cat "$pid_file")"',
    '[ -n "$pid" ]',
    'kill -0 "$pid" 2>/dev/null',
    'capture_helper_resolve "$pid"',
  ].join('\n');
}

function buildCaptureHelperResolveFunction(): string {
  return [
    'capture_helper_resolve() {',
    '  timeout_bin="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"',
    '  if [ -n "$timeout_bin" ]; then',
    '    "$timeout_bin" 3s capture-helper resolve --pid "$1" --json >/dev/null 2>&1',
    '    return $?',
    '  fi',
    '  python3 - "$1" <<\'PY\'',
    'import subprocess',
    'import sys',
    'try:',
    '    subprocess.run(',
    '        ["capture-helper", "resolve", "--pid", sys.argv[1], "--json"],',
    '        stdout=subprocess.DEVNULL,',
    '        stderr=subprocess.DEVNULL,',
    '        timeout=3,',
    '        check=True,',
    '    )',
    'except Exception:',
    '    sys.exit(1)',
    'PY',
    '}',
  ].join('\n');
}

async function recoverBrowserPidFromCdp(
  slotId: string,
  resourceId: string,
  resourceDef: NonNullable<RawProjectJson['resources']>[string],
  slotVars: Awaited<ReturnType<typeof loadSlotVars>>,
  projectVars: Awaited<ReturnType<typeof loadProjectVars>>,
): Promise<{ ok: boolean; detail?: string }> {
  if (resourceDef.type !== 'browser') return { ok: false };

  const rawPort = slotVars.resourceVars.cdp_port;
  const cdpPort = rawPort ? Number(rawPort) : NaN;
  if (!Number.isInteger(cdpPort) || cdpPort <= 0 || cdpPort > 65_535) return { ok: false };

  const pidPath = browserPidPath(resourceDef, slotVars, projectVars);
  if (!pidPath) return { ok: false };
  const pidDir = path.dirname(pidPath);
  const cmd = buildBrowserPidRecoveryCommand(cdpPort, pidDir);
  const result = await execResourceCommand(slotId, slotVars.repo, cmd, 5_000);
  if (result.exitCode !== 0) return { ok: false };

  return { ok: true, detail: `${resourceId} pid repaired from cdp_port ${cdpPort}` };
}

export function buildBrowserPidRecoveryCommand(cdpPort: number, pidDir: string): string {
  const qPidDir = shellQuote(pidDir);
  return [
    'set -e',
    buildCaptureHelperResolveFunction(),
    `pid_dir=${qPidDir}`,
    'lsof_bin="$(command -v lsof 2>/dev/null || true)"',
    '[ -n "$lsof_bin" ] || lsof_bin=/usr/sbin/lsof',
    `pid="$($lsof_bin -ti tcp:${cdpPort} -sTCP:LISTEN 2>/dev/null | head -1)"`,
    '[ -n "$pid" ]',
    'kill -0 "$pid" 2>/dev/null',
    'capture_helper_resolve "$pid"',
    'mkdir -p "$pid_dir"',
    'printf "%s\\n" "$pid" > "$pid_dir/browser.pid"',
    'printf "%s\\n" "$pid" > "$pid_dir/chromium.pid"',
  ].join('\n');
}

export function buildBrowserNodeWatchCommand(pidPath: string, cdpPortRaw?: string): string {
  const cdpPort = cdpPortRaw ? Number(cdpPortRaw) : NaN;
  const pidFileCheck = [
    `pid_file=${shellQuote(pidPath)}`,
    'if [ -f "$pid_file" ]; then',
    '  pid="$(cat "$pid_file" 2>/dev/null || true)"',
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && capture_helper_resolve "$pid"; then',
    '    exit 0',
    '  fi',
    'fi',
  ];

  if (!Number.isInteger(cdpPort) || cdpPort <= 0 || cdpPort > 65_535) {
    return ['set -e', buildCaptureHelperResolveFunction(), ...pidFileCheck, 'exit 1'].join('\n');
  }

  return [
    'set -e',
    buildCaptureHelperResolveFunction(),
    ...pidFileCheck,
    `pid_dir=${shellQuote(path.dirname(pidPath))}`,
    'lsof_bin="$(command -v lsof 2>/dev/null || true)"',
    '[ -n "$lsof_bin" ] || lsof_bin=/usr/sbin/lsof',
    `pid="$($lsof_bin -ti tcp:${cdpPort} -sTCP:LISTEN 2>/dev/null | head -1)"`,
    '[ -n "$pid" ]',
    'kill -0 "$pid" 2>/dev/null',
    'capture_helper_resolve "$pid"',
    'mkdir -p "$pid_dir"',
    'printf "%s\\n" "$pid" > "$pid_dir/browser.pid"',
    'printf "%s\\n" "$pid" > "$pid_dir/chromium.pid"',
  ].join('\n');
}

/**
 * Poll all resources for a single slot. Updates cache and returns results.
 */
export async function pollSlotResources(
  slotId: string,
  opts?: { probeInactiveSimulators?: boolean },
): Promise<ResourceStateUpdate[]> {
  const resources = await resolveSlotResources(slotId);
  if (resources.length === 0) return [];
  const slot = getCachedFleet()?.slots.find((s) => s.slot === slotId);

  const results: Array<{ id: string; status: ResourceStatus }> = [];

  await Promise.all(
    resources.map(async (r) => {
      if (!opts?.probeInactiveSimulators && !shouldProbeResourceForSlot(slot, r.definition)) {
        results.push({ id: r.id, status: getCachedResourceStatus(slotId, r.id) });
        return;
      }
      if (!r.definition.hooks?.health) {
        // No health hook — keep as unknown
        results.push({ id: r.id, status: 'unknown' });
        return;
      }
      try {
        const health = await executeResourceHealth(slotId, r.id);
        results.push({ id: r.id, status: health.ok ? 'running' : 'stopped' });
      } catch {
        results.push({ id: r.id, status: 'error' });
      }
    }),
  );

  // Update cache and detect changes
  let changed = false;
  if (!statusCache.has(slotId)) {
    statusCache.set(slotId, new Map());
  }
  const slotCache = statusCache.get(slotId)!;

  for (const r of results) {
    const prev = slotCache.get(r.id);
    if (prev !== r.status) {
      changed = true;
      slotCache.set(r.id, r.status);
    }
    changed = resetStreamStateIfInactiveLifecycle(slotId, r.id, r.status) || changed;
  }

  // Broadcast if any status changed
  if (changed) {
    broadcastSlotResources(slotId, results);
  }

  return buildResourceUpdates(slotId, results);
}

/**
 * Poll all slots in the fleet for resource health.
 */
async function pollAllResources(): Promise<void> {
  if (pollAllInFlight) return;
  pollAllInFlight = true;
  try {
    const fleet = await loadFleetStatus();
    const slotIds = fleet.slots.map((s) => s.slot);
    purgeRemovedSlotWarnings(warnedUnconfiguredResources, new Set(slotIds));
    const failures: string[] = [];
    await mapWithConcurrency(slotIds, RESOURCE_POLL_CONCURRENCY, async (id) => {
      try {
        await pollSlotResources(id);
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    });
    if (failures.length > 0) {
      const suffix = failures.length > 5 ? `; +${failures.length - 5} more` : '';
      console.warn(
        `[resource-manager] ${failures.length}/${slotIds.length} slot resource polls failed: ${failures.slice(0, 5).join('; ')}${suffix}`,
      );
    }
  } catch (err) {
    console.error(`[resource-manager] poll error: ${(err as Error).message}`);
  } finally {
    pollAllInFlight = false;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Start periodic resource health polling.
 */
export function startResourcePolling(
  broadcast: (event: string, payload: unknown) => void,
  intervalMs = 60_000,
): void {
  broadcastFn = broadcast;
  // Initial poll after a short delay (let fleet state load first)
  const initialTimer = setTimeout(() => pollAllResources(), 3_000);
  initialTimer.unref();
  pollTimer = setInterval(() => pollAllResources(), intervalMs);
  pollTimer.unref();
  console.log(`[resource-manager] polling started (interval=${intervalMs}ms)`);
}

/**
 * Stop periodic resource health polling.
 */
export function stopResourcePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  broadcastFn = null;
}

// ─── Agent push-based resource monitoring ───

/**
 * Handle an inbound resource status change from an agent.
 * Updates cache and broadcasts to UI clients.
 */

// Best-effort current-run lookup for stale detection. Uses the cached fleet
// to avoid re-hitting disk on every resource event.
function currentRunIdForSlot(slotId: string): string | null {
  const fleet = getCachedFleet();
  if (!fleet) return null;
  const slot = fleet.slots.find((s) => s.slot === slotId);
  return slot?.currentRunId ?? null;
}

export function handleNodeResourceChanged(payload: {
  machine: string;
  slotId: string;
  resourceId: string;
  status: string;
  pid?: number;
  oldPid?: number;
  newPid?: number;
  at?: string;
  meta?: ResourceSidecarMeta;
}): void {
  const { slotId, resourceId, status } = payload;

  // Relaunch: swap sticky pointer atomically; do NOT drop stream sessions; keep
  // cached status as running. Broadcast a dedicated relaunch event so consumers
  // can rebind to the new pid without re-subscribing.
  if (status === 'relaunched') {
    const oldPid = payload.oldPid ?? payload.pid ?? 0;
    const newPid = payload.newPid ?? payload.pid ?? 0;
    const at = payload.at ?? new Date().toISOString();
    // Mirror the running-branch stale detection: a relaunch whose sidecar meta
    // declares a runId that doesn't match the slot's current run is stale,
    // regardless of whether the new pid is up. Without this, a relaunch event
    // for a prior run's resource races ahead of the normal running push and
    // locks the cache into 'running' — masking the mismatch until the next
    // status push (which may never come for a dead run).
    let effectiveStatus: ResourceStatus = 'running';
    if (newPid > 0) {
      const prev = getActiveResource(slotId, resourceId);
      const meta = payload.meta ?? prev?.meta;
      setActiveResource(slotId, resourceId, {
        pid: newPid,
        startedAt: at,
        runId: payload.meta?.runId ?? prev?.runId ?? null,
        cdpPort: prev?.cdpPort,
        ...(meta ? { meta } : {}),
      });
      if (payload.meta?.runId) {
        const slotRunId = currentRunIdForSlot(slotId);
        if (slotRunId !== null && payload.meta.runId !== slotRunId) {
          effectiveStatus = 'stale';
        }
      }
    }
    if (!statusCache.has(slotId)) statusCache.set(slotId, new Map());
    const slotCache = statusCache.get(slotId)!;
    const prevStatus = slotCache.get(resourceId);
    slotCache.set(resourceId, effectiveStatus);
    console.log(
      `[resource-manager] relaunched: ${slotId}/${resourceId} oldPid=${oldPid} newPid=${newPid} status=${effectiveStatus}`,
    );
    const relaunchPayload: ResourceRelaunchedPayload = { slotId, resourceId, oldPid, newPid, at };
    emitRelaunched(relaunchPayload);
    if (broadcastFn) {
      broadcastFn(Events.RESOURCE_RELAUNCHED, relaunchPayload);
    }
    // Broadcast the rollup update so the UI's status pills reflect stale
    // detection on relaunch. Without this, RESOURCE_RELAUNCHED flips the pid
    // but consumers that rely on RESOURCE_STATUS_UPDATED (slot rollup, badge)
    // keep showing the old status.
    if (prevStatus !== effectiveStatus) {
      broadcastSlotResources(slotId, [{ id: resourceId, status: effectiveStatus }]);
    }
    return;
  }

  const validStatus = (['running', 'stopped', 'unknown', 'error'] as ResourceStatus[]).includes(
    status as ResourceStatus,
  )
    ? (status as ResourceStatus)
    : 'unknown';

  let effectiveStatus: ResourceStatus = validStatus;

  if (validStatus === 'running' && typeof payload.pid === 'number' && payload.pid > 0) {
    const prev = getActiveResource(slotId, resourceId);
    const metaForPointer = payload.meta ?? prev?.meta;
    setActiveResource(slotId, resourceId, {
      pid: payload.pid,
      startedAt: payload.at ?? new Date().toISOString(),
      runId: payload.meta?.runId ?? prev?.runId ?? null,
      cdpPort: prev?.cdpPort,
      ...(metaForPointer ? { meta: metaForPointer } : {}),
    });
    // Stale detection: sidecar declares a runId that is not the slot's current
    // run. We only flag stale on an actual runId mismatch — a null
    // currentRunId is the normal keep-warm state (resetSlot(slotId, true)
    // clears currentRunId but deliberately leaves resources alive for the
    // next dispatch), so treating it as stale would tear down every warm
    // slot's resources on the next running event.
    if (payload.meta?.runId) {
      const slotRunId = currentRunIdForSlot(slotId);
      if (slotRunId !== null && payload.meta.runId !== slotRunId) {
        effectiveStatus = 'stale';
      }
    }
  } else if (validStatus === 'stopped') {
    deleteActiveResource(slotId, resourceId);
  }

  if (!statusCache.has(slotId)) {
    statusCache.set(slotId, new Map());
  }
  const slotCache = statusCache.get(slotId)!;
  const prev = slotCache.get(resourceId);

  const streamChanged = resetStreamStateIfInactiveLifecycle(slotId, resourceId, effectiveStatus);
  if (prev === effectiveStatus && !streamChanged) return; // no change

  slotCache.set(resourceId, effectiveStatus);
  console.log(
    `[resource-manager] node push: ${slotId}/${resourceId} ${prev ?? 'unknown'} → ${effectiveStatus}`,
  );

  const resources = Array.from(slotCache.entries()).map(([id, s]) => ({ id, status: s }));
  broadcastSlotResources(slotId, resources);
}

/**
 * Send resource watch instructions to an agent for all slots on its machine.
 * Called when an agent connects.
 */
export async function sendWatchInstructions(machine: string): Promise<void> {
  if (!resourceWatchAutoStartEnabled) return;

  const node = getNode(machine);
  if (!node) return;

  try {
    const fleet = await loadFleetStatus();
    const machineSlots = fleet.slots.filter((s) => s.machine === machine && s.enabled);

    let totalWatches = 0;
    for (const slot of machineSlots) {
      try {
        const { pool, slot: slotCfg } = await resolveSlot(slot.slot);
        const projectName = slotCfg.project ?? pool.project;
        const projectVars = await loadProjectVars(projectName);
        const projectJson = projectVars.projectJson;
        const slotVars = await loadSlotVars(slot.slot);

        const watchInstructions: Array<{
          id: string;
          watch: {
            type: string;
            path?: string;
            port?: number;
            cmd?: string;
            cwd?: string;
            provider?: ResourceWatchProvider;
            target?: string;
            intervalMs?: number;
          };
        }> = [];

        for (const [id, def] of Object.entries(projectJson.resources ?? {})) {
          if (!isSlotResourceConfigured(slotCfg.resources, id)) continue;
          if (!def.watch) continue;

          const expandedWatch: {
            type: string;
            path?: string;
            port?: number;
            cmd?: string;
            cwd?: string;
            provider?: ResourceWatchProvider;
            target?: string;
            intervalMs?: number;
          } = { type: def.watch.type };

          if (def.watch.path) {
            const expanded = expandTemplate(def.watch.path, slotVars, projectVars);
            if (hasUnresolvedPlaceholders(expanded)) continue;
            // Make path absolute relative to repo
            expandedWatch.path = expanded.startsWith('/')
              ? expanded
              : `${slotVars.remoteRepo}/${expanded}`;
          }

          if (def.watch.port) {
            const expanded = expandTemplate(def.watch.port, slotVars, projectVars);
            if (hasUnresolvedPlaceholders(expanded)) continue;
            const port = parseInt(expanded, 10);
            if (isNaN(port)) continue;
            expandedWatch.port = port;
          }

          if (def.watch.cmd) {
            const expanded = expandTemplate(def.watch.cmd, slotVars, projectVars);
            if (hasUnresolvedPlaceholders(expanded)) continue;
            expandedWatch.cmd = expanded;
            expandedWatch.cwd = slotVars.remoteRepo;
          }

          const sharedProvider = inferSharedProcessPollProvider(
            {
              type: def.type as ResourceDefinition['type'],
              platform: def.platform,
              watch: {
                type: def.watch.type as ResourceWatchType,
                provider: def.watch.provider,
              },
            },
            expandedWatch.cmd ?? '',
          );
          if (sharedProvider) {
            const targetTemplate =
              def.watch.target ??
              (sharedProvider === 'ios-simulator-inventory'
                ? String(slotVars.resourceVars.simulator ?? '')
                : '');
            const target = expandTemplate(targetTemplate, slotVars, projectVars).trim();
            if (target && !hasUnresolvedPlaceholders(target)) {
              expandedWatch.provider = sharedProvider;
              expandedWatch.target = target;
              if (!def.watch.provider) {
                const inferenceKey = `${projectName}:${id}`;
                if (!loggedLegacySharedProviderInferences.has(inferenceKey)) {
                  loggedLegacySharedProviderInferences.add(inferenceKey);
                  console.log(
                    `[resource-manager] inferred shared ${sharedProvider} provider for legacy ${inferenceKey}; declare watch.provider + watch.target in project.json`,
                  );
                }
              }
            }
          }

          if (def.watch.intervalMs) {
            expandedWatch.intervalMs = def.watch.intervalMs;
          }

          if (def.type === 'browser' && expandedWatch.path) {
            // Keep pid-file watch semantics so node events still carry pid,
            // sidecar meta, and relaunch coalescing. The command only repairs
            // stale/missing pid files from CDP before the pid-file watcher
            // re-reads the canonical file.
            expandedWatch.cmd = buildBrowserNodeWatchCommand(
              expandedWatch.path,
              slotVars.resourceVars.cdp_port,
            );
            expandedWatch.cwd = slotVars.remoteRepo;
            delete expandedWatch.port;
          }

          watchInstructions.push({ id, watch: expandedWatch });
        }

        // The node treats this as the complete watch set for the slot, so send
        // an empty set too. Omitting the request would leave removed watches alive.
        await sendNodeRequest(node, 'resource.watch.start', {
          slotId: slot.slot,
          resources: watchInstructions,
        });
        totalWatches += watchInstructions.length;
      } catch (err) {
        console.log(
          `[resource-manager] failed to send watch for ${slot.slot}: ${(err as Error).message}`,
        );
      }
    }

    if (totalWatches > 0) {
      console.log(`[resource-manager] sent ${totalWatches} watch instructions to node ${machine}`);
    }
  } catch (err) {
    console.error(
      `[resource-manager] sendWatchInstructions error for ${machine}: ${(err as Error).message}`,
    );
  }
}

export async function setResourceWatchesEnabled(
  enabled: boolean,
): Promise<ResourceWatchSetEnabledResult> {
  resourceWatchAutoStartEnabled = enabled;
  resourceWatchStateUpdatedAt = new Date().toISOString();
  persistResourceWatchState(enabled, resourceWatchStateUpdatedAt);

  const fleet = await loadFleetStatus();
  const connectedMachines = new Set(getAllNodes().map((node) => node.machine));
  const affectedMachines = Array.from(
    new Set(
      fleet.slots
        .filter((slot) => slot.enabled && connectedMachines.has(slot.machine))
        .map((slot) => slot.machine),
    ),
  ).sort();
  const affectedSlots = fleet.slots
    .filter((slot) => slot.enabled && affectedMachines.includes(slot.machine))
    .map((slot) => slot.slot)
    .sort();

  if (enabled) {
    for (const machine of affectedMachines) {
      await sendWatchInstructions(machine);
    }
    return { ok: true, enabled, affectedMachines, affectedSlots };
  }

  for (const slot of fleet.slots) {
    if (!slot.enabled || !affectedMachines.includes(slot.machine)) continue;
    const node = getNode(slot.machine);
    if (!node) continue;
    await sendNodeRequest(node, 'resource.watch.stop', { slotId: slot.slot });
  }

  for (const machine of affectedMachines) {
    await clearMachineResourceStatus(machine);
  }
  return { ok: true, enabled, affectedMachines, affectedSlots };
}

/**
 * Mark all resources for a machine as 'unknown' when its agent disconnects.
 */
export async function clearMachineResourceStatus(machine: string): Promise<void> {
  try {
    const fleet = await loadFleetStatus();
    const machineSlots = fleet.slots.filter((s) => s.machine === machine);

    for (const slot of machineSlots) {
      const slotCache = statusCache.get(slot.slot);
      if (!slotCache) continue;

      let changed = false;
      for (const [resourceId, status] of slotCache) {
        if (status !== 'unknown') {
          slotCache.set(resourceId, 'unknown');
          changed = true;
        }
      }

      for (const resourceId of slotCache.keys()) {
        changed =
          resetStreamStateIfInactiveLifecycle(
            slot.slot,
            resourceId,
            slotCache.get(resourceId) ?? 'unknown',
          ) || changed;
      }

      if (changed) {
        const resources = Array.from(slotCache.entries()).map(([id, s]) => ({ id, status: s }));
        broadcastSlotResources(slot.slot, resources);
      }
    }

    console.log(`[resource-manager] cleared resource status for machine ${machine}`);
  } catch (err) {
    console.error(`[resource-manager] clearMachineResourceStatus error: ${(err as Error).message}`);
  }
}

/**
 * Execute a resource control hook (boot, shutdown, relaunch).
 * After control, immediately re-polls the slot's resources.
 */
export async function executeResourceControl(
  slotId: string,
  resourceId: string,
  action: ResourceControlAction,
): Promise<{ ok: boolean; detail?: string }> {
  const { pool, slot } = await resolveSlot(slotId);
  if (!isSlotResourceConfigured(slot.resources, resourceId)) {
    return { ok: false, detail: `Resource '${resourceId}' is not configured for slot '${slotId}'` };
  }
  const projectName = slot.project ?? pool.project;
  const projectVars = await loadProjectVars(projectName);
  const projectJson = projectVars.projectJson;
  const slotVars = await loadSlotVars(slotId);

  const resourceDef = projectJson.resources?.[resourceId];
  if (!resourceDef) {
    return { ok: false, detail: `Resource '${resourceId}' not found in project config` };
  }

  const hookCmd = resourceDef.hooks?.[action];
  if (!hookCmd) {
    return { ok: false, detail: `No '${action}' hook defined for resource '${resourceId}'` };
  }

  const expanded = expandTemplate(hookCmd, slotVars, projectVars);

  // Check for unresolved required variables after expansion
  if (hasUnresolvedPlaceholders(expanded)) {
    const unresolved = findUnresolvedPlaceholders(expanded);
    return { ok: true, detail: `skipped (${unresolved.join(', ')} not configured)` };
  }

  // For shutdown: skip if health check says resource isn't running
  if (action === 'shutdown' && resourceDef.hooks?.health) {
    const health = await executeResourceHealth(slotId, resourceId);
    if (!health.ok) {
      return { ok: true, detail: 'already stopped' };
    }
  }

  // Execute via agent for remote machines, locally otherwise
  const { isLocal, machine } = await getSlotLocality(slotId);
  let result: { ok: boolean; detail?: string };

  if (!isLocal) {
    const node = getNode(machine);
    if (!node) {
      return { ok: false, detail: `No node connected for ${machine}` };
    }
    try {
      const execResult = (await sendNodeRequest(node, 'exec', {
        cmd: expanded,
        cwd: slotVars.repo,
        timeout: 30_000,
      })) as { stdout: string; stderr: string; exitCode: number };
      if (execResult.exitCode === 0) {
        result = { ok: true, detail: execResult.stdout?.trim() || undefined };
      } else {
        const msg = execResult.stderr?.trim() || `exit ${execResult.exitCode}`;
        if (/Unable to (shutdown|boot) device in current state/i.test(msg)) {
          result = {
            ok: true,
            detail: action === 'shutdown' ? 'already stopped' : 'already running',
          };
        } else {
          result = { ok: false, detail: msg };
        }
      }
    } catch (err) {
      result = { ok: false, detail: (err as Error).message };
    }
  } else {
    const execResult = await execLocal(expanded, { cwd: slotVars.repo, timeout: 30_000 });
    if (execResult.exitCode === 0) {
      result = { ok: true, detail: execResult.stdout.trim() || undefined };
    } else {
      const msg = execResult.stderr || `exit ${execResult.exitCode}`;
      if (/Unable to (shutdown|boot) device in current state/i.test(msg)) {
        result = {
          ok: true,
          detail: action === 'shutdown' ? 'already stopped' : 'already running',
        };
      } else {
        result = { ok: false, detail: msg };
      }
    }
  }

  // After a successful boot, write a sidecar `<pidPath>.meta` next to the
  // watched pidfile so downstream readers (resource-watch.ts, ResourceRollup,
  // stale-orphan detection) can identify which run owns the process. Without
  // this, every launched resource arrives at the gateway without meta, so
  // currentRunIdForSlot-based stale detection never triggers and a previous
  // run's leaked process keeps reporting `running` against the new run.
  if (
    action === 'boot' &&
    result.ok &&
    resourceDef.watch?.type === 'pid-file' &&
    typeof resourceDef.watch.path === 'string'
  ) {
    const expanded = expandTemplate(resourceDef.watch.path, slotVars, projectVars);
    // sendWatchInstructions (:563) resolves relative watch.path against
    // slotVars.remoteRepo before handing it to the node watcher. Mirror that
    // resolution here so `<pidPath>.meta` lands next to the ACTUAL watched
    // pidfile. Without this, relative paths like `{{runtime_dir}}/browser.pid`
    // cause the gateway to write the sidecar under the gateway/node CWD while
    // the node reads `<remoteRepo>/<runtime_dir>/browser.pid.meta` — meta
    // never reaches readSidecarMeta and the stale/rollup path stays dark.
    const pidPath = expanded.startsWith('/') ? expanded : `${slotVars.remoteRepo}/${expanded}`;
    if (!hasUnresolvedPlaceholders(pidPath)) {
      const runId = currentRunIdForSlot(slotId);
      // Skip the sidecar entirely when the slot has no active run (keep-warm
      // boot, detached reconcile). node-side readSidecarMeta rejects any
      // sidecar whose runId is empty, so writing `runId: ''` would just leave
      // a stale file from a prior boot masquerading as current. Without a
      // run, there is nothing for stale-orphan detection to mismatch against
      // anyway — the sidecar is re-emitted on the next boot that has a run.
      if (runId) {
        const meta = { runId, slotId, startedAt: new Date().toISOString() };
        const metaPath = `${pidPath}.meta`;
        writeSidecarMeta(slotId, metaPath, meta).catch((err) => {
          console.warn(
            `[resource-manager] sidecar write failed slot=${slotId} resource=${resourceId} path=${metaPath} err=${(err as Error).message}`,
          );
        });
      }
    }
  }

  // Immediate re-poll after control action
  pollSlotResources(slotId).catch((err) => {
    console.warn(
      `[resource-manager] immediate resource poll failed for ${slotId}: ${(err as Error).message}`,
    );
  });

  return result;
}

async function writeSidecarMeta(
  slotId: string,
  metaPath: string,
  meta: { runId: string; slotId: string; startedAt: string },
): Promise<void> {
  const content = JSON.stringify(meta);
  const { isLocal, machine } = await getSlotLocality(slotId);
  if (isLocal) {
    await mkdir(path.dirname(metaPath), { recursive: true }).catch(() => {});
    await writeFile(metaPath, content, 'utf-8');
    return;
  }
  const node = getNode(machine);
  if (!node) {
    // Node not connected — skip silently. resource-watch on the remote host
    // simply won't see a sidecar; stale detection degrades to "coherent"
    // rather than failing closed on an offline node.
    return;
  }
  // Ensure the pidfile's parent dir exists before the sidecar write, matching
  // the local branch's recursive mkdir. Remote pidfile paths typically live
  // under a preflight-created runtime dir, but for first-boot edge cases or
  // projects that nest the pidfile deeper, skipping mkdir would ENOENT the
  // fs.write and drop the sidecar.
  const metaDir = path.dirname(metaPath);
  await sendNodeRequest(node, 'fs.mkdir', { root: metaDir, relPath: '.' });
  await sendNodeRequest(node, 'fs.write', {
    root: metaDir,
    relPath: path.basename(metaPath),
    content,
  });
}
