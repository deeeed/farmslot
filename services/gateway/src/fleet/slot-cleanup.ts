// slot-cleanup.ts — unified slot teardown RPC
// Iterates a slot's resources in reverse-boot order and fires their shutdown hooks
// with a per-resource timeout. Intended to be called either explicitly via the
// slot.cleanup RPC or as a fire-and-forget hook from core/state.ts:resetSlot.

import type { SlotCleanupParams, SlotCleanupResult } from '@farmslot/protocol';

import {
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
  readSlotField,
} from '../core/index.js';

import {
  deleteActiveResource,
  executeResourceControl,
  executeResourceHealth,
  resolveSlotResources,
  setCachedResourceStatus,
} from './resource-manager.js';
import { cleanupSlotStorage } from './slot-storage-cleanup.js';

const PER_RESOURCE_TIMEOUT_MS = 15_000;
// Short settle between the shutdown hook returning and the health re-poll.
// Hooks that succeed via `pkill -f` / `launchctl stop` may leave the process
// torn-down-but-not-yet-reaped for a few hundred ms; polling immediately
// would misread "process exiting" as "still running" and pin a slot that
// was actually torn down correctly.
const POST_SHUTDOWN_VERIFY_DELAY_MS = 500;

async function verifyShutdownTook(slotId: string, resourceId: string): Promise<boolean> {
  // If there is no health hook, we have nothing to verify against. Trust the
  // shutdown exit code rather than pinning every no-health resource forever.
  await new Promise((r) => setTimeout(r, POST_SHUTDOWN_VERIFY_DELAY_MS));
  try {
    const health = await executeResourceHealth(slotId, resourceId);
    // health.ok === true means the resource is STILL healthy (reachable/alive).
    // A "no hook" / placeholder-skipped health returns ok:true too, but that
    // just means we can't disprove shutdown — fall back to trusting the hook.
    if (!health.ok) return false;
    const detail = health.detail ?? '';
    if (detail.startsWith('skipped')) return false;
    return true;
  } catch {
    // If verification itself throws, don't block release on an introspection
    // bug — treat as "can't disprove", fall back to trusting the hook.
    return false;
  }
}
// Upper bound on how long slotCleanup will wait on already-timed-out
// shutdowns before giving up and returning. Gives slow-but-eventually-ok
// hooks a chance to land inside the same cleanup call so the dispatcher
// doesn't hand out the slot mid-teardown.
const DRAIN_TIMEOUT_MS = 15_000;

// Guard against concurrent cleanups for the same slot. A Map (not a Set) so
// overlapping callers (manual RPC, orphan sweep, lifecycle resetSlot) all
// await the same in-flight result instead of short-circuiting with a fake
// "cleanup already in progress" ok response — which would let resetSlot flip
// the slot back to `ready` while shutdown hooks are still running.
const cleanupInProgress = new Map<string, Promise<SlotCleanupResult>>();

interface ResourceShutdownOutcome {
  resourceId: string;
  kind: 'cleaned' | 'skipped';
  reason?: string;
  // True when the process is provably gone (shutdown ok OR already-stopped OR
  // no hook configured). False for timeout / failure — caller should keep the
  // sticky pointer so orphan sweep can retry.
  torn: boolean;
}

async function shutdownResource(
  slotId: string,
  resourceId: string,
  hasShutdownHook: boolean,
  hasHealthHook: boolean,
  pending: Promise<void>[],
): Promise<ResourceShutdownOutcome> {
  if (!hasShutdownHook) {
    return { resourceId, kind: 'skipped', reason: 'no shutdown hook', torn: true };
  }

  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctrl = executeResourceControl(slotId, resourceId, 'shutdown');
    const timeout = new Promise<{ ok: false; detail: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, detail: `timeout after ${PER_RESOURCE_TIMEOUT_MS}ms` }),
        PER_RESOURCE_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([ctrl, timeout]);
    const duration = Date.now() - start;

    if (result.ok) {
      const already = result.detail === 'already stopped';
      // executeResourceControl returns ok:true with `detail: 'skipped (...)'`
      // when placeholders in the hook could not be resolved (e.g. {{port}}
      // missing). That means the hook never ran — the process, if any, is
      // untouched — so we must NOT mark the resource stopped or drop the
      // sticky pointer. Orphan sweep needs to keep retrying.
      const skipped = typeof result.detail === 'string' && result.detail.startsWith('skipped');
      const resultLabel = skipped ? `skipped-${result.detail}` : already ? 'already-stopped' : 'ok';
      console.log(
        `[teardown] slot=${slotId} resource=${resourceId} action=shutdown result=${resultLabel} duration=${duration}ms`,
      );
      if (skipped) {
        return {
          resourceId,
          kind: 'skipped',
          reason: result.detail ?? 'hook skipped',
          torn: false,
        };
      }
      // Post-shutdown verify: zero exit on the hook does NOT prove the process
      // died — a no-op shutdown like `"shutdown": "true"` exits 0 but kills
      // nothing. Re-run the health hook (which is also used by boot/control to
      // decide "already stopped") after a short settle. If it reports healthy
      // again, the shutdown was useless; keep the pointer and report as failed
      // so orphan sweep retries instead of releasing a contaminated slot.
      if (!already && hasHealthHook) {
        const stillAlive = await verifyShutdownTook(slotId, resourceId);
        if (stillAlive) {
          console.warn(
            `[teardown] slot=${slotId} resource=${resourceId} action=shutdown error=post-verify-still-running duration=${duration}ms`,
          );
          setCachedResourceStatus(slotId, resourceId, 'running');
          return { resourceId, kind: 'skipped', reason: 'post-verify still running', torn: false };
        }
      }
      // Always flip the cached status to stopped — including the 'already stopped'
      // branch. Without this, a slot whose cache still advertises running/stale
      // keeps getting flagged by the cleanup button + orphan sweep after teardown.
      setCachedResourceStatus(slotId, resourceId, 'stopped');
      return already
        ? { resourceId, kind: 'skipped', reason: 'already stopped', torn: true }
        : { resourceId, kind: 'cleaned', torn: true };
    }

    // Timeout case: the hook is still running. Race returned, but letting
    // slotCleanup return now would let the dispatcher hand the slot out
    // before the old shutdown lands — a pattern-matching hook (e.g. pkill
    // by process name) could then tear down the NEXT run's resource. Track
    // the promise so the caller can drain it (bounded) before returning.
    const late = ctrl.then(
      async (r) => {
        const d = Date.now() - start;
        if (r.ok) {
          const already = r.detail === 'already stopped';
          const skipped = typeof r.detail === 'string' && r.detail.startsWith('skipped');
          const label = skipped
            ? `late-skipped-${r.detail}`
            : already
              ? 'late-already-stopped'
              : 'late-ok';
          console.log(
            `[teardown] slot=${slotId} resource=${resourceId} action=shutdown result=${label} duration=${d}ms`,
          );
          if (skipped) return;
          // Mirror the primary path's post-verify: a zero exit on a slow
          // shutdown hook does NOT prove the process died. Re-run the health
          // hook before clearing the sticky pointer / flipping the cache.
          // Without this, a pattern-matching hook that eventually exits 0 but
          // kills nothing would release a contaminated slot and prevent
          // orphan sweep from ever retrying (pointer gone + cache=stopped).
          // `already-stopped` is exempt — that detail is only returned when
          // the hook itself observed the resource was already down.
          if (!already && hasHealthHook) {
            const stillAlive = await verifyShutdownTook(slotId, resourceId);
            if (stillAlive) {
              console.warn(
                `[teardown] slot=${slotId} resource=${resourceId} action=shutdown error=late-post-verify-still-running duration=${d}ms`,
              );
              setCachedResourceStatus(slotId, resourceId, 'running');
              return;
            }
          }
          setCachedResourceStatus(slotId, resourceId, 'stopped');
          // Drop the sticky pointer when a timed-out shutdown eventually
          // succeeds AND post-verify confirms the process is gone (or the
          // resource was already stopped / has no health hook to verify
          // against). Without this, the primary outcome (returned already as
          // torn:false) keeps the pointer and resetSlot would hold the slot
          // at busy/releasing until the next reconcile pass — an artificial
          // 60s stall after teardown really finished.
          deleteActiveResource(slotId, resourceId);
        } else {
          console.warn(
            `[teardown] slot=${slotId} resource=${resourceId} action=shutdown error=late-${r.detail ?? 'unknown'} duration=${d}ms`,
          );
        }
      },
      (err) => {
        const d = Date.now() - start;
        console.warn(
          `[teardown] slot=${slotId} resource=${resourceId} action=shutdown error=late-${(err as Error).message} duration=${d}ms`,
        );
      },
    );
    pending.push(late);

    console.warn(
      `[teardown] slot=${slotId} resource=${resourceId} action=shutdown error=${result.detail ?? 'unknown'} duration=${duration}ms`,
    );
    return { resourceId, kind: 'skipped', reason: result.detail ?? 'shutdown failed', torn: false };
  } catch (err) {
    const duration = Date.now() - start;
    const msg = (err as Error).message;
    console.warn(
      `[teardown] slot=${slotId} resource=${resourceId} action=shutdown error=${msg} duration=${duration}ms`,
    );
    return { resourceId, kind: 'skipped', reason: msg, torn: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function slotCleanup(params: SlotCleanupParams): Promise<SlotCleanupResult> {
  const { slotId, reason } = params;

  const existing = cleanupInProgress.get(slotId);
  if (existing) {
    // Piggyback on the in-flight cleanup so callers only return once teardown
    // has really finished. resetSlot relies on this to avoid releasing the
    // slot mid-shutdown.
    console.log(`[slot-cleanup] slot=${slotId} reason=${reason} awaiting=cleanup-already-running`);
    return existing;
  }

  const run = runCleanup(slotId, reason);
  cleanupInProgress.set(slotId, run);
  try {
    return await run;
  } finally {
    cleanupInProgress.delete(slotId);
  }
}

async function runCleanup(slotId: string, reason: string): Promise<SlotCleanupResult> {
  const resources = await resolveSlotResources(slotId);
  console.log(`[slot-cleanup] slot=${slotId} reason=${reason} resources=${resources.length}`);

  // Reverse-boot order: resources in project.json declare boot order, shutdown is the inverse.
  const ordered = [...resources].reverse();

  // Shutdowns that timed out but whose underlying process is still running
  // get tracked here so we drain them (bounded) before returning. Without
  // this, a slow hook that eventually completes could tear down the NEXT
  // run's freshly started resource.
  const pending: Promise<void>[] = [];

  const outcomes: ResourceShutdownOutcome[] = [];
  for (const r of ordered) {
    const hasShutdownHook = !!r.definition.hooks?.shutdown;
    const hasHealthHook = !!r.definition.hooks?.health;
    const outcome = await shutdownResource(slotId, r.id, hasShutdownHook, hasHealthHook, pending);
    outcomes.push(outcome);
  }

  // Drain outstanding timed-out shutdowns before releasing the slot to the
  // dispatcher. Bounded by DRAIN_TIMEOUT_MS so a truly hung hook doesn't
  // block the slot forever — at that point the sticky pointer stays put
  // and orphan sweep takes over on the next tick.
  if (pending.length > 0) {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
    ]);
  }

  const cleaned: string[] = [];
  const skipped: string[] = [];
  const skippedReason: Record<string, string> = {};
  for (const o of outcomes) {
    if (o.kind === 'cleaned') {
      cleaned.push(o.resourceId);
    } else {
      skipped.push(o.resourceId);
      if (o.reason) skippedReason[o.resourceId] = o.reason;
    }
  }

  // Only drop sticky pointers for resources that were actually torn down
  // (shutdown ok, already-stopped, or no hook). Failed/timeout resources
  // keep their pointer so the next explicit cleanup RPC can retry —
  // otherwise leaked processes become invisible.
  for (const o of outcomes) {
    if (o.torn) deleteActiveResource(slotId, o.resourceId);
  }

  let storageDeleted: string[] = [];
  const storageSkippedReason: Record<string, string> = {};
  try {
    const vars = await loadSlotVars(slotId);
    let projectJson: RawProjectJson = {};
    try {
      projectJson = (await loadProjectVars(vars.projectName)).projectJson;
    } catch (err) {
      // Legacy or external test slots may not have project metadata. Falling
      // back to default .agent/.task roots still gives the cleanup button a
      // chance to clear worker-owned caches without failing resource teardown.
      console.warn(
        `[slot-cleanup] slot=${slotId} storage project config fallback: ${(err as Error).message.slice(0, 200)}`,
      );
    }
    const activeTaskRel = (await readSlotField(slotId, 'task_file')) as string | null | undefined;
    const storage = await cleanupSlotStorage(vars, projectJson, {
      activeTaskRel,
      includeBrowserProfiles: true,
    });
    storageDeleted = storage.deleted.map((entry) => entry.path);
    for (const entry of storage.skipped) {
      storageSkippedReason[entry.path] = `${entry.label}: ${entry.reason}`;
    }
    const runtimeDir = getProjectField(projectJson, 'paths.runtime_dir') || '.agent';
    console.log(
      `[slot-cleanup] slot=${slotId} storage=${storageDeleted.length} runtime=${runtimeDir}`,
    );
  } catch (err) {
    // Resource teardown is the primary contract for slot.cleanup. Storage
    // pruning is an opportunistic follow-up, so keep the resource result
    // visible and report the storage failure in the typed cleanup response.
    storageSkippedReason['slot-storage'] = (err as Error).message.slice(0, 200);
    console.warn(
      `[slot-cleanup] slot=${slotId} storage cleanup failed: ${storageSkippedReason['slot-storage']}`,
    );
  }

  const hasReasons = Object.keys(skippedReason).length > 0;
  const hasStorageReasons = Object.keys(storageSkippedReason).length > 0;
  return {
    ok: true,
    cleaned,
    skipped,
    ...(hasReasons ? { skippedReason } : {}),
    ...(storageDeleted.length > 0 ? { storageDeleted } : {}),
    ...(hasStorageReasons ? { storageSkippedReason } : {}),
  };
}
