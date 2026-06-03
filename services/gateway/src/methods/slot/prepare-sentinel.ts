import path from 'node:path';

import type { SlotPrepareParams } from '@farmslot/protocol';

import {
  execOnSlot,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  type SlotVars,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { loadFleetStatus } from '../../fleet/state.js';

const PREPARE_SENTINEL = '.preparing.lock';
const PREPARE_SENTINEL_MAX_AGE_SECONDS = 5 * 60;
const PREPARE_SENTINEL_HEARTBEAT_MS = 30_000;

export interface PrepareSentinelLock {
  vars: SlotVars;
  lockDir: string;
  lockPath: string;
  heartbeat?: ReturnType<typeof setInterval>;
}

// Track heartbeats so a process-wide shutdown clears them; without this a
// premature `process.exit()` from another module leaks the timer (the lock
// itself self-recovers via PREPARE_SENTINEL_MAX_AGE_SECONDS).
const activeHeartbeats = new Set<ReturnType<typeof setInterval>>();
let heartbeatShutdownBound = false;
function bindHeartbeatShutdown(): void {
  if (heartbeatShutdownBound) return;
  heartbeatShutdownBound = true;
  const cleanup = () => {
    if (activeHeartbeats.size === 0) return;
    for (const t of activeHeartbeats) clearInterval(t);
    activeHeartbeats.clear();
  };
  // Both events registered: 'beforeExit' fires on natural drain, 'exit' on
  // process.exit(). The size guard makes the second invocation a no-op when
  // the first already cleared the set.
  process.once('beforeExit', cleanup);
  process.once('exit', cleanup);
}

async function resolvePrepareRuntimeDir(projectName: string): Promise<string> {
  try {
    const projectVars = await loadProjectVars(projectName);
    return projectVars.runtimeDir || '.agent';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Project config not found:')) return '.agent';
    throw error;
  }
}

function prepareSentinelPaths(
  remoteRepo: string,
  runtimeDir: string,
): { lockDir: string; lockPath: string } {
  const lockDir = path.posix.join(remoteRepo, runtimeDir || '.agent');
  return { lockDir, lockPath: path.posix.join(lockDir, PREPARE_SENTINEL) };
}

export async function acquirePrepareSentinel(
  vars: SlotVars,
  params: SlotPrepareParams,
): Promise<PrepareSentinelLock | null> {
  if (!vars.slotEnabled) return null;

  const runtimeDir = await resolvePrepareRuntimeDir(vars.projectName);
  const paths = prepareSentinelPaths(vars.remoteRepo, runtimeDir);
  const metadata = [
    `slot=${vars.slotId}`,
    `machine=${vars.machine}`,
    `project=${vars.projectName}`,
    `branch=${params.branch || ''}`,
    `gateway_pid=${process.pid}`,
  ]
    .map((line) => `printf '%s\\n' ${shellQuote(line)}`)
    .join('; ');

  // Use mkdir for atomic lock acquisition — unlike `set -C` (noclobber),
  // mkdir is atomic across concurrent SSH writers and bash callers.
  const metadataFile = `${paths.lockPath}/info`;
  const create = await execOnSlot(
    vars,
    [
      `mkdir -p ${shellQuote(paths.lockDir)}`,
      `mkdir ${shellQuote(paths.lockPath)}`,
      // Roll back the lock dir if the metadata write fails (disk full, perms);
      // an empty lock would otherwise hold for PREPARE_SENTINEL_MAX_AGE_SECONDS
      // and the error message at :148 would have no holder info to surface.
      `{ ${metadata}; printf 'remote_pid=%s\\n' "$$"; printf 'started_at=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > ${shellQuote(metadataFile)} || { rm -rf ${shellQuote(paths.lockPath)}; exit 1; }`,
    ].join(' && '),
  );
  if (create.exitCode === 0) return { vars, ...paths };

  // Stale detection: a lock owned by a different gateway PID can't belong to
  // an in-flight prepare on this gateway (each gateway invocation has a
  // unique process.pid). Reclaim it immediately. This handles tsx-watch
  // reloads and crashes — without it, the heartbeat on the dead gateway
  // stops updating mtime but the lock takes up to PREPARE_SENTINEL_MAX_AGE_SECONDS
  // to age out, blocking every retry in the meantime. Age-based fallback
  // still catches same-PID heartbeat failures (event-loop hangs).
  const currentPid = String(process.pid);
  const stale = await execOnSlot(
    vars,
    [
      `LOCK=${shellQuote(paths.lockPath)}`,
      `META=${shellQuote(metadataFile)}`,
      `lock_gw_pid=$(awk -F= '$1=="gateway_pid"{print $2}' "$META" 2>/dev/null | tail -1)`,
      'now=$(date +%s)',
      'mtime=$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo "$now")',
      'age=$((now - mtime))',
      `if [ -z "$lock_gw_pid" ] || [ "$lock_gw_pid" != ${shellQuote(currentPid)} ] || [ "$age" -gt ${PREPARE_SENTINEL_MAX_AGE_SECONDS} ]; then`,
      '  rm -rf "$LOCK"',
      '  echo "stale"',
      'else',
      '  echo "active age=$age gw_pid=$lock_gw_pid"',
      'fi',
    ].join('\n'),
  );

  if (stale.stdout.trim() === 'stale') {
    console.warn(`[slot.prepare] removed stale prepare lock for ${vars.slotId}: ${paths.lockPath}`);
    const retry = await execOnSlot(
      vars,
      [
        `mkdir -p ${shellQuote(paths.lockDir)}`,
        `mkdir ${shellQuote(paths.lockPath)}`,
        `{ ${metadata}; printf 'remote_pid=%s\\n' "$$"; printf 'started_at=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > ${shellQuote(metadataFile)}`,
      ].join(' && '),
    );
    if (retry.exitCode === 0) return { vars, ...paths };
  }

  const existing = await execOnSlot(vars, `cat ${shellQuote(metadataFile)} 2>/dev/null || true`);
  const holder = existing.stdout.trim();
  const detail = (create.stderr || create.stdout).trim().slice(-240);
  throw new Error(
    [
      `Slot ${vars.slotId} is already preparing or its prepare lock could not be created: ${paths.lockPath}`,
      detail ? `Lock error: ${detail}` : '',
      holder ? `Current lock:\n${holder}` : '',
      'Remove the lock only after verifying no prepare/reset/checkout is still running on the slot.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export async function releasePrepareSentinel(
  lock: PrepareSentinelLock,
  originalError?: unknown,
): Promise<void> {
  if (lock.heartbeat) {
    clearInterval(lock.heartbeat);
    activeHeartbeats.delete(lock.heartbeat);
  }
  let release: { stdout: string; stderr: string; exitCode: number };
  try {
    release = await execOnSlot(lock.vars, `rm -rf ${shellQuote(lock.lockPath)}`);
  } catch (error) {
    if (originalError) {
      // Preserve the prepare failure as the actionable root cause; the lock path is logged for manual cleanup.
      console.warn(
        `[slot.prepare] Failed to remove prepare lock for ${lock.vars.slotId}: ${lock.lockPath} (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    throw error;
  }
  if (release.exitCode === 0) return;

  const message = `Failed to remove prepare lock for ${lock.vars.slotId}: ${lock.lockPath} (${(release.stderr || release.stdout).trim().slice(-240)})`;
  if (originalError) {
    // Preserve the prepare failure as the actionable root cause; the lock path is logged for manual cleanup.
    console.warn(`[slot.prepare] ${message}`);
    return;
  }
  throw new Error(message);
}

export function startPrepareSentinelHeartbeat(lock: PrepareSentinelLock): void {
  bindHeartbeatShutdown();
  lock.heartbeat = setInterval(() => {
    execOnSlot(
      lock.vars,
      `test -d ${shellQuote(lock.lockPath)} && touch ${shellQuote(lock.lockPath)}`,
    ).catch((error) => {
      console.warn(
        `[slot.prepare] prepare lock heartbeat failed for ${lock.vars.slotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, PREPARE_SENTINEL_HEARTBEAT_MS);
  lock.heartbeat.unref?.();
  activeHeartbeats.add(lock.heartbeat);
}

// On gateway startup, locks left by a previous (now-dead) gateway have no
// running heartbeat, so their mtime is frozen. Three missed heartbeats
// (>90s) reliably indicates orphan vs. live in-flight prepare. Without this,
// orphan locks block new prepares for the full 5min PREPARE_SENTINEL_MAX_AGE_SECONDS.
const PREPARE_SENTINEL_ORPHAN_THRESHOLD_SECONDS = Math.ceil(
  (PREPARE_SENTINEL_HEARTBEAT_MS / 1000) * 3,
);

/**
 * Cap parallel remote SSH probes so a 20-slot fleet doesn't burst 20
 * simultaneous SSH connections at gateway boot. Local slots are exempt
 * (no SSH cost). Remote slots run in batches of this size.
 */
const RECONCILE_REMOTE_CONCURRENCY = 4;

/**
 * Per-probe wall-clock cap. Without this, a single wedged remote host
 * (DNS hung, ssh ControlMaster stale, host genuinely down) would hold its
 * batch slot for the full ssh ConnectTimeout (default ~75s), starving the
 * remaining batches. 15s is enough headroom for a healthy ssh+stat round
 * trip; anything slower we'd rather skip than block startup on.
 */
const RECONCILE_PROBE_TIMEOUT_MS = 15_000;

export async function reconcileStalePrepareLocks(): Promise<void> {
  const fleet = await loadFleetStatus();
  const enabled = fleet.slots.filter((s) => s.enabled);

  const probeOne = async (slotId: string): Promise<void> => {
    try {
      const vars = await loadSlotVars(slotId);
      const runtimeDir = await resolvePrepareRuntimeDir(vars.projectName);
      const paths = prepareSentinelPaths(vars.remoteRepo, runtimeDir);
      // We deliberately omit the `|| echo "$now"` fallback: if both stat
      // invocations fail (busybox, missing PATH, lock dir vanished mid-probe)
      // we want a STAT_FAILED token, not a silent "live age=0" that masks
      // a genuine orphan lock as healthy.
      const probe = await Promise.race([
        execOnSlot(
          vars,
          [
            `LOCK=${shellQuote(paths.lockPath)}`,
            'if [ ! -d "$LOCK" ]; then echo absent; exit 0; fi',
            'now=$(date +%s)',
            'mtime=$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo STAT_FAILED)',
            'if [ "$mtime" = "STAT_FAILED" ]; then echo "stat-failed"; exit 0; fi',
            'age=$((now - mtime))',
            `if [ "$age" -gt ${PREPARE_SENTINEL_ORPHAN_THRESHOLD_SECONDS} ]; then rm -rf "$LOCK"; echo "removed age=$age"; else echo "live age=$age"; fi`,
          ].join('\n'),
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`reconcile probe timed out after ${RECONCILE_PROBE_TIMEOUT_MS}ms`)),
            RECONCILE_PROBE_TIMEOUT_MS,
          ),
        ),
      ]);
      const out = probe.stdout.trim();
      if (out.startsWith('removed')) {
        console.warn(
          `[slot.prepare] startup reconcile: cleared orphan lock for ${slotId} (${out}) at ${paths.lockPath}`,
        );
      } else if (out.startsWith('live')) {
        console.log(
          `[slot.prepare] startup reconcile: live lock for ${slotId} (${out}) at ${paths.lockPath}`,
        );
      } else if (out === 'stat-failed') {
        console.warn(
          `[slot.prepare] startup reconcile: stat unavailable on ${slotId}; lock state unknown at ${paths.lockPath} — leaving in place, will retry next prepare`,
        );
      }
    } catch (error) {
      console.warn(
        `[slot.prepare] startup reconcile skipped for ${slotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Partition by locality first so we know which slots need throttling. We
  // don't have isLocal on SlotStatus, so peek at vars; loadSlotVars itself
  // is cheap enough to run for every slot up-front.
  const slotIds = enabled.map((s) => s.slot);
  const probedVars = await Promise.all(
    slotIds.map((id) =>
      loadSlotVars(id)
        .then((v) => ({ id, isLocal: isLocal(v.host, v.machine) }))
        .catch(() => ({ id, isLocal: false })),
    ),
  );
  const localIds = probedVars.filter((p) => p.isLocal).map((p) => p.id);
  const remoteIds = probedVars.filter((p) => !p.isLocal).map((p) => p.id);

  // Locals run in parallel — no SSH cost.
  await Promise.all(localIds.map(probeOne));

  // Remote slots run in bounded batches to avoid SSH ControlMaster setup
  // races and to keep slow hosts from being hammered.
  for (let i = 0; i < remoteIds.length; i += RECONCILE_REMOTE_CONCURRENCY) {
    const batch = remoteIds.slice(i, i + RECONCILE_REMOTE_CONCURRENCY);
    await Promise.all(batch.map(probeOne));
  }
}
