// methods/fleet-refresh.ts — Bulk slot refresh orchestrator.
//
// Operator clicks "Refresh idle" → UI lists eligible slots → confirms a
// per-slot mode (safe / force) → this module schedules slot.refresh per
// slot with per-machine serial / cross-machine parallel execution and
// global concurrency cap. Streams progress as fleet.refresh.* events
// keyed by a single bulk requestId, plus per-slot script.output /
// script.complete (each slot.refresh has its own requestId echoed back
// in fleet.refresh.scheduled).
//
// No timer, no auto-trigger. Operator-initiated only.

import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  Events,
  type FleetPrSummaryEntry,
  type FleetPrSummaryParams,
  type FleetPrSummaryResult,
  type FleetRefreshSlotsCancelParams,
  type FleetRefreshSlotsCancelResult,
  type FleetRefreshSlotsParams,
  type FleetRefreshSlotsResult,
  type FleetRefreshSlotStatus,
} from '@farmslot/protocol';

import { loadFleetStatus } from '../fleet/state.js';

import { prForSlot } from './pr.js';
import { slotRefresh, slotRefreshBlockedReason } from './slot.js';

const execFile = promisify(execFileCb);

type EventEmitter = (event: string, payload: unknown) => void;

interface BulkRun {
  abort: AbortController;
  perSlotRequestIds: Map<string, string>;
  perSlotAborts: Map<string, AbortController>;
  startedAt: number;
}

const activeBulkRuns = new Map<string, BulkRun>();
const GLOBAL_CONCURRENCY_CAP = 4;

// ─── fleet.refreshSlots ───
// Returns synchronously after pre-allocating per-slot requestIds and
// emitting fleet.refresh.scheduled. The actual scheduler runs detached
// so events flow without holding the response open.

export async function fleetRefreshSlots(
  params: FleetRefreshSlotsParams,
  emit: EventEmitter,
): Promise<FleetRefreshSlotsResult> {
  if (!Array.isArray(params.slots) || params.slots.length === 0) {
    throw new Error('fleet.refreshSlots: at least one slot required');
  }
  // De-dup by slotId (last mode wins) to avoid scheduling the same slot twice.
  const dedupedMap = new Map<string, 'safe' | 'force'>();
  for (const entry of params.slots) {
    if (!entry.slotId) continue;
    dedupedMap.set(entry.slotId, entry.mode);
  }
  const requested = Array.from(dedupedMap, ([slotId, mode]) => ({ slotId, mode }));
  if (requested.length === 0) throw new Error('fleet.refreshSlots: no valid slotIds after de-dup');

  const requestId = params.requestId ?? `fleet-refresh-${randomUUID()}`;
  if (activeBulkRuns.has(requestId)) {
    throw new Error(`fleet.refreshSlots: requestId ${requestId} already active`);
  }

  const perSlotRequestIds = new Map<string, string>();
  for (const { slotId } of requested) {
    // Bulk requestId already carries the namespace prefix; just append the slot.
    perSlotRequestIds.set(slotId, `${requestId}-${slotId}`);
  }

  const bulk: BulkRun = {
    abort: new AbortController(),
    perSlotRequestIds,
    perSlotAborts: new Map(),
    startedAt: Date.now(),
  };
  activeBulkRuns.set(requestId, bulk);

  // Emit scheduled BEFORE returning so the UI can subscribe to per-slot
  // streams using perSlotRequestIds the moment our response lands.
  emit(Events.FLEET_REFRESH_SCHEDULED, {
    requestId,
    total: requested.length,
    perSlotRequestIds: Object.fromEntries(perSlotRequestIds),
  });

  // Detach the scheduler so the request handler can return immediately.
  void runScheduler(requestId, requested, bulk, emit).finally(() => {
    activeBulkRuns.delete(requestId);
  });

  return {
    requestId,
    scheduled: requested.length,
    perSlotRequestIds: Object.fromEntries(perSlotRequestIds),
  };
}

// ─── fleet.refreshSlots.cancel ───
// Aborts the bulk + every in-flight per-slot. Slots not yet started will
// be reported as cancelled. Slots mid-git-step finish that step then bail.

export function fleetRefreshSlotsCancel(
  params: FleetRefreshSlotsCancelParams,
): FleetRefreshSlotsCancelResult {
  const bulk = activeBulkRuns.get(params.requestId);
  if (!bulk) return { cancelled: false, reason: 'requestId not found or already complete' };
  bulk.abort.abort();
  for (const ctrl of bulk.perSlotAborts.values()) ctrl.abort();
  return { cancelled: true };
}

// ─── fleet.prSummary ───
// Best-effort PR-state annotation for stale-branch slots in the modal.
// Failures degrade silently — every slot gets an entry, slots without
// data have all-null fields. Calls run in parallel; gh unavailability
// or auth failure on any single slot does not block the rest.

export async function fleetPrSummary(params: FleetPrSummaryParams): Promise<FleetPrSummaryResult> {
  const slotIds = Array.isArray(params.slotIds) ? params.slotIds : [];
  const settled = await Promise.allSettled(
    slotIds.map(async (slotId): Promise<[string, FleetPrSummaryEntry]> => {
      try {
        const lookup = await prForSlot({ slotId });
        if (!lookup.pr || !lookup.repo) {
          return [slotId, { prNumber: null, state: null, repo: null }];
        }
        const state = await fetchPrState(lookup.repo, lookup.pr);
        return [slotId, { prNumber: lookup.pr, state, repo: lookup.repo }];
      } catch {
        // Recoverable: gh unavailable / auth failed / repo missing / network.
        // The annotation is strictly cosmetic — the bulk method tolerates a
        // null entry, the modal classifies the slot as "PR state unknown"
        // (treated as dangerous, hard-blocked behind the override toggle),
        // so degrading silently here is the correct behavior.
        return [slotId, { prNumber: null, state: null, repo: null }];
      }
    }),
  );
  const entries: Record<string, FleetPrSummaryEntry> = {};
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      const [slotId, entry] = result.value;
      entries[slotId] = entry;
    }
  }
  return { entries };
}

async function fetchPrState(repo: string, pr: number): Promise<FleetPrSummaryEntry['state']> {
  // Single round-trip after prForSlot resolves the (repo, pr) pair. We
  // ask for both `state` and `mergedAt` because gh reports `closed` for
  // both merged and closed-without-merge — `mergedAt` distinguishes.
  try {
    const { stdout } = await execFile(
      'gh',
      ['api', `repos/${repo}/pulls/${pr}`, '--jq', '{state, mergedAt: .merged_at}'],
      { timeout: 8000 },
    );
    const parsed = JSON.parse(stdout || '{}') as { state?: string; mergedAt?: string | null };
    if (parsed.mergedAt) return 'merged';
    if (parsed.state === 'open') return 'open';
    if (parsed.state === 'closed') return 'closed';
    return null;
  } catch {
    // Recoverable: gh exec timeout / auth / network / unparseable output.
    // Returning null surfaces as "PR state unknown" upstream → row classified
    // as dangerous → hard-blocked unless operator explicitly overrides.
    // Conservative by design.
    return null;
  }
}

// ─── Scheduler internals ───

async function runScheduler(
  requestId: string,
  requested: Array<{ slotId: string; mode: 'safe' | 'force' }>,
  bulk: BulkRun,
  emit: EventEmitter,
): Promise<void> {
  const summary = { refreshed: 0, skipped: 0, failed: 0, cancelled: 0 };

  // Group by machine. Slots on the same machine run serially to avoid
  // SSH login storms; different machines run in parallel under the
  // global cap.
  let fleet;
  try {
    fleet = await loadFleetStatus();
  } catch (err) {
    // Without fleet data we can't classify by machine. Treat every slot
    // as failed so the UI gets a summary and clears its modal state.
    for (const { slotId } of requested) {
      emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
        requestId,
        slotId,
        status: 'failed' as FleetRefreshSlotStatus,
        detail: `fleet load failed: ${(err as Error).message}`,
      });
      summary.failed++;
    }
    emitSummary(emit, requestId, summary, bulk.startedAt);
    return;
  }

  const slotsByMachine = new Map<string, Array<{ slotId: string; mode: 'safe' | 'force' }>>();
  for (const item of requested) {
    const slot = fleet.slots.find((s) => s.slot === item.slotId);
    const machine = slot?.machine ?? '__unknown__';
    if (!slotsByMachine.has(machine)) slotsByMachine.set(machine, []);
    slotsByMachine.get(machine)!.push(item);
  }

  // Per-machine queue iterator — each machine yields its slots one at a time.
  const machineQueues = Array.from(slotsByMachine.values()).map((queue) => ({
    queue,
    inFlight: false,
  }));

  // Identity-tracked task pool. We avoid Promise.race(arr.map((p,i)=>p.then(()=>i)))
  // because two tasks can settle near-simultaneously while we're awaiting and
  // the second iteration's index would be stale (it'd splice a still-running
  // task). Identity Set + finally-driven removal sidesteps the race entirely.
  const inFlight = new Set<Promise<void>>();
  let activeCount = 0;

  const startNext = (): boolean => {
    if (bulk.abort.signal.aborted) return false;
    if (activeCount >= GLOBAL_CONCURRENCY_CAP) return false;
    const next = machineQueues.find((m) => !m.inFlight && m.queue.length > 0);
    if (!next) return false;
    const item = next.queue.shift()!;
    next.inFlight = true;
    activeCount++;
    const task: Promise<void> = runSlot(requestId, item, bulk, emit, summary).finally(() => {
      next.inFlight = false;
      activeCount--;
      inFlight.delete(task);
    });
    inFlight.add(task);
    return true;
  };

  while (startNext()) {
    /* prime the pool */
  }

  // Drain by waiting on whichever task settles next, then top up the pool.
  // The finally above removes the settled task from `inFlight` so size shrinks
  // monotonically. When all machines drain, size goes to 0 and we exit.
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    while (startNext()) {
      /* fill */
    }
  }

  // Cancelled slots that never started: emit cancelled events and count.
  if (bulk.abort.signal.aborted) {
    for (const machine of machineQueues) {
      for (const item of machine.queue) {
        emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
          requestId,
          slotId: item.slotId,
          status: 'cancelled' as FleetRefreshSlotStatus,
          detail: 'cancelled before start',
        });
        summary.cancelled++;
      }
      machine.queue.length = 0;
    }
  }

  emitSummary(emit, requestId, summary, bulk.startedAt);
}

async function runSlot(
  requestId: string,
  item: { slotId: string; mode: 'safe' | 'force' },
  bulk: BulkRun,
  emit: EventEmitter,
  summary: { refreshed: number; skipped: number; failed: number; cancelled: number },
): Promise<void> {
  const { slotId, mode } = item;
  const perSlotRequestId = bulk.perSlotRequestIds.get(slotId);
  if (!perSlotRequestId) {
    // Should never happen — perSlotRequestIds is built from the same set.
    summary.failed++;
    return;
  }

  if (bulk.abort.signal.aborted) {
    emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
      requestId,
      slotId,
      status: 'cancelled' as FleetRefreshSlotStatus,
      detail: 'cancelled before start',
    });
    summary.cancelled++;
    return;
  }

  // Re-check eligibility against fresh fleet data right before executing.
  // A slot that became busy/held since modal-open gets skipped, not
  // refreshed mid-worker.
  try {
    const fleet = await loadFleetStatus();
    const slot = fleet.slots.find((s) => s.slot === slotId);
    const blocked = slotRefreshBlockedReason(slot);
    if (blocked) {
      emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
        requestId,
        slotId,
        status: 'skipped' as FleetRefreshSlotStatus,
        detail: blocked,
      });
      summary.skipped++;
      return;
    }
  } catch (err) {
    emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
      requestId,
      slotId,
      status: 'failed' as FleetRefreshSlotStatus,
      detail: `pre-check failed: ${(err as Error).message}`,
    });
    summary.failed++;
    return;
  }

  // Per-slot abort wired into the bulk abort signal so cancel() reaches
  // both the parent loop and any in-flight git steps.
  const slotAbort = new AbortController();
  bulk.perSlotAborts.set(slotId, slotAbort);
  const onBulkAbort = () => slotAbort.abort();
  bulk.abort.signal.addEventListener('abort', onBulkAbort, { once: true });

  emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
    requestId,
    slotId,
    status: 'running' as FleetRefreshSlotStatus,
    mode,
  });

  try {
    const result = await slotRefresh({ slotId, mode, requestId: perSlotRequestId }, emit);
    if (result.refreshed) {
      emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
        requestId,
        slotId,
        status: 'refreshed' as FleetRefreshSlotStatus,
        detail: result.advanced ? 'advanced' : 'already up-to-date',
        mode,
      });
      summary.refreshed++;
    } else {
      // Safe-mode no-op (dirty / stale). UI surfaces a per-row Force button
      // gated on the typed `recoverableViaForce` flag, not substring grep.
      const reason = result.reason;
      emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
        requestId,
        slotId,
        status: 'failed' as FleetRefreshSlotStatus,
        detail: reason ?? 'safe mode aborted',
        mode,
        recoverableViaForce: reason === 'dirty' || reason === 'stale',
      });
      summary.failed++;
    }
  } catch (err) {
    if (slotAbort.signal.aborted || bulk.abort.signal.aborted) {
      emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
        requestId,
        slotId,
        status: 'cancelled' as FleetRefreshSlotStatus,
        detail: 'cancelled mid-step',
      });
      summary.cancelled++;
    } else {
      // Unexpected throw — slot.refresh resolves dirty/stale rather than
      // throwing today, so reaching here means a transport/SSH/exec failure.
      // Force-mode retry would not recover; explicitly false so the UI
      // doesn't surface a misleading Force button.
      emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
        requestId,
        slotId,
        status: 'failed' as FleetRefreshSlotStatus,
        detail: (err as Error).message ?? 'unknown error',
        mode,
        recoverableViaForce: false,
      });
      summary.failed++;
    }
  } finally {
    bulk.abort.signal.removeEventListener('abort', onBulkAbort);
    bulk.perSlotAborts.delete(slotId);
  }
}

function emitSummary(
  emit: EventEmitter,
  requestId: string,
  summary: { refreshed: number; skipped: number; failed: number; cancelled: number },
  startedAt: number,
): void {
  emit(Events.FLEET_REFRESH_SUMMARY, {
    requestId,
    refreshed: summary.refreshed,
    skipped: summary.skipped,
    failed: summary.failed,
    cancelled: summary.cancelled,
    durationMs: Date.now() - startedAt,
  });
}
