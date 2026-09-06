// core/state.ts — .farm-status.json state management
// TypeScript port of lib/slot-common.sh: update_farm_status

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { resolveStatusFilePath } from '../projects/repo-root.js';

import { farmslotRoot } from './config.js';

const statusFile = resolveStatusFilePath(farmslotRoot);

/** Called with the slotId whenever resetSlot runs (higher layers register cleanups). */
const slotResetListeners: Array<(slotId: string) => void> = [];

export function onSlotReset(listener: (slotId: string) => void): void {
  slotResetListeners.push(listener);
}

// Serialize read-modify-write so concurrent updates to different slots don't stomp each other.
let writeChain: Promise<void> = Promise.resolve();

async function atomicWriteStatus(data: unknown): Promise<void> {
  const tmp = `${statusFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, statusFile);
}

// ─── Broadcast hook ───
// Registered by server.ts so every updateSlotStatus triggers a fleet broadcast.
// Debounced to coalesce rapid successive calls (e.g. release resets multiple fields).
let onSlotUpdated: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 50;

export function setSlotUpdateHook(hook: () => void): void {
  onSlotUpdated = hook;
}

function triggerSlotUpdateHook(): void {
  if (!onSlotUpdated) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    onSlotUpdated?.();
  }, DEBOUNCE_MS);
}

// ─── updateSlotStatus ───
// Update one or more fields on a slot in .farm-status.json.
// Mirrors bash update_farm_status() but supports multiple fields at once.

export async function updateSlotStatus(
  slotId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const next = writeChain.then(async () => {
    if (!existsSync(statusFile)) return;

    const content = await readFile(statusFile, 'utf-8');
    const data = JSON.parse(content);

    const slots: Array<Record<string, unknown>> = data.slots ?? [];
    const slot = slots.find((s) => s.slot === slotId);
    if (!slot) return;

    for (const [key, value] of Object.entries(fields)) {
      slot[key] = value;
    }

    await atomicWriteStatus(data);
    triggerSlotUpdateHook();
  });
  writeChain = next.catch(() => {}); // keep chain alive on error; re-throw to caller below
  await next;
}

// ─── updateSlotStatusIf ───
// Atomic compare-and-set: only apply `fields` if `predicate(currentSlot)`
// holds when the chain reaches us. Use this to avoid clobbering state that
// another writer set between our read and our write — e.g. dispatch flipping
// the slot to `busy` while a slow fetch finishes. Returns true if the write
// was applied, false otherwise.
export async function updateSlotStatusIf(
  slotId: string,
  predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
  fields: Record<string, unknown>,
): Promise<boolean> {
  let applied = false;
  const next = writeChain.then(async () => {
    if (!existsSync(statusFile)) return;
    const content = await readFile(statusFile, 'utf-8');
    const data = JSON.parse(content);
    const slots: Array<Record<string, unknown>> = data.slots ?? [];
    const slot = slots.find((s) => s.slot === slotId);
    if (!slot) return;
    if (!predicate(slot)) return;
    for (const [key, value] of Object.entries(fields)) {
      slot[key] = value;
    }
    await atomicWriteStatus(data);
    triggerSlotUpdateHook();
    applied = true;
  });
  writeChain = next.catch(() => {});
  await next;
  return applied;
}

/**
 * Claim-type slot write: atomically applies `fields` when `predicate` passes
 * and bumps the slot ownership epoch in the same serialized write. The epoch
 * is the coordination token between claimers and teardowns — a teardown
 * captures it at entry and guards its later writes on it, so a successful
 * rival claim aborts the remainder of an in-flight teardown instead of being
 * clobbered by it. Returns the new epoch on success.
 */
export async function claimSlotStatusIf(
  slotId: string,
  predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
  fields: Record<string, unknown>,
): Promise<{ claimed: boolean; epoch: number | null }> {
  let claimed = false;
  let epoch: number | null = null;
  const next = writeChain.then(async () => {
    const data: { slots?: Array<Record<string, unknown>> } = existsSync(statusFile)
      ? JSON.parse(await readFile(statusFile, 'utf-8'))
      : {};
    const slots: Array<Record<string, unknown>> = (data.slots = data.slots ?? []);
    let slot = slots.find((s) => s.slot === slotId);
    if (!slot) {
      // A missing row means NOTHING owns the slot: a freshly added pool entry
      // has no status until the first fleet refresh. Refusing here would
      // conflate "no state" with "mid-release" and make new slots permanently
      // unclaimable (teardown-type writers correctly stay no-ops on missing
      // rows — there is nothing to tear down). The claim creates the row it
      // claims.
      slot = { slot: slotId, slot_epoch: 0 };
      slots.push(slot);
    }
    if (!predicate(slot)) return;
    const nextEpoch = (Number(slot.slot_epoch) || 0) + 1;
    for (const [key, value] of Object.entries(fields)) {
      slot[key] = value;
    }
    slot.slot_epoch = nextEpoch;
    await atomicWriteStatus(data);
    triggerSlotUpdateHook();
    claimed = true;
    epoch = nextEpoch;
  });
  writeChain = next.catch(() => {});
  await next;
  return { claimed, epoch };
}

/**
 * Teardown-entry CAS: atomically validates `predicate`, applies `fields`, and
 * returns the slot's CURRENT ownership epoch (no bump — only claims bump).
 * Release uses this so owner validation, the releasing marker, and epoch
 * capture happen in ONE serialized write: an owner sampled before unrelated
 * awaits can never be silently replaced by a rival claim's.
 */
export async function markSlotStatusIf(
  slotId: string,
  predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
  fields: Record<string, unknown>,
): Promise<{ applied: boolean; epoch: number | null }> {
  let applied = false;
  let epoch: number | null = null;
  const next = writeChain.then(async () => {
    if (!existsSync(statusFile)) return;
    const content = await readFile(statusFile, 'utf-8');
    const data = JSON.parse(content);
    const slots: Array<Record<string, unknown>> = data.slots ?? [];
    const slot = slots.find((s) => s.slot === slotId);
    if (!slot) return;
    if (!predicate(slot)) return;
    for (const [key, value] of Object.entries(fields)) {
      slot[key] = value;
    }
    await atomicWriteStatus(data);
    triggerSlotUpdateHook();
    applied = true;
    epoch = Number(slot.slot_epoch) || 0;
  });
  writeChain = next.catch(() => {});
  await next;
  return { applied, epoch };
}

/**
 * Full status-file rewrite routed through the same write chain as every other
 * slot write, with the builder receiving the CURRENT file content inside the
 * chain — a snapshot taken before entering the chain would silently drop any
 * claim (owner + epoch bump) that landed in between.
 */
export async function rewriteStatusFile(
  builder: (current: { slots?: Array<Record<string, unknown>> } | null) => unknown,
): Promise<void> {
  const next = writeChain.then(async () => {
    let current: { slots?: Array<Record<string, unknown>> } | null = null;
    if (existsSync(statusFile)) {
      try {
        const parsed = JSON.parse(await readFile(statusFile, 'utf-8'));
        // Malformed-but-parseable shapes (slots as an object, null rows) must
        // not crash the rebuild that would repair them — normalize to a clean
        // row array or regenerate from live checks via null.
        const slots = Array.isArray(parsed?.slots)
          ? parsed.slots.filter((row: unknown) => row && typeof row === 'object')
          : null;
        current = slots ? { ...parsed, slots } : null;
      } catch {
        // A corrupt status file must not block the rebuild that repairs it —
        // the builder receives null and regenerates from live checks.
        current = null;
      }
    }
    await atomicWriteStatus(builder(current));
    triggerSlotUpdateHook();
  });
  writeChain = next.catch(() => {});
  await next;
}

// ─── readSlotField ───
// Read a single field from a slot in .farm-status.json.

export async function readSlotField(slotId: string, field: string): Promise<unknown> {
  if (!existsSync(statusFile)) return undefined;

  const content = await readFile(statusFile, 'utf-8');
  const data = JSON.parse(content);

  const slots: Array<Record<string, unknown>> = data.slots ?? [];
  const slot = slots.find((s) => s.slot === slotId);
  return slot?.[field];
}

// ─── Typed transition helpers ───
// Enforce valid lifecycle+phase+agent combos by construction.
// See docs/adr/022-slot-lifecycle-simplification.md for valid states.

type BusyPhase = 'preparing' | 'dispatching' | 'working' | 'releasing' | 'review-gate';

/**
 * Coordination token shared by the slot lifecycle protocol: release marks
 * this phase BEFORE any teardown side effect, and every claim-type writer
 * refuses a slot carrying it. Centralized so the writers cannot drift.
 */
export const SLOT_PHASE_RELEASING: BusyPhase = 'releasing';
type HeldPhase = 'ci-watch' | 'pr-watch';

/**
 * When the releasing fence went up, as an ISO timestamp.
 *
 * The slot row carries `slot_epoch` but no clock, and the epoch cannot say how
 * long a fence has been standing. Without that, a release interrupted between
 * fencing the slot and finishing it strands the slot for good: the reconciler
 * skips a releasing slot, `resetSlot` refuses one, and `slotRelease` returns
 * `released: false` for one. This is what lets a bounded reclaim tell a
 * teardown in progress from one that died.
 */
export const SLOT_RELEASING_SINCE = 'releasing_since';

/** The releasing fence, stamped so a stalled one can be told from a live one. */
export function slotReleasingFenceFields(now = new Date()): Record<string, unknown> {
  return {
    lifecycle: 'busy',
    phase: SLOT_PHASE_RELEASING,
    [SLOT_RELEASING_SINCE]: now.toISOString(),
  };
}

function slotResetFields(warm: boolean): Record<string, unknown> {
  return {
    lifecycle: 'ready',
    phase: null,
    [SLOT_RELEASING_SINCE]: null,
    agent: 'idle',
    warm,
    current_run_id: null,
    current_flow_type: null,
    current_ticket_or_pr: null,
    current_mode: null,
    current_family_id: null,
    current_lane: null,
    current_variant: null,
    agent_contexts: null,
    handoff_run_id: null,
  };
}

/**
 * CAS'd variant of resetSlot for teardowns: applies the ready/idle reset only
 * while `predicate` still holds (release guards on its entry epoch), so a
 * rival claim landing mid-teardown is never clobbered by the final reset.
 * Listeners fire only when the reset was actually applied.
 */
export async function resetSlotIf(
  slotId: string,
  predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
  warm = false,
): Promise<boolean> {
  const applied = await updateSlotStatusIf(slotId, predicate, slotResetFields(warm));
  if (applied) {
    for (const listener of slotResetListeners) listener(slotId);
  }
  return applied;
}

/**
 * Ownership-release fields for a terminal run whose slot carries a pending
 * foreign handoff reservation: the full ready/idle reset EXCEPT
 * `handoff_run_id`, which stays so the reserved run's final claim still
 * succeeds after its delivery landed.
 */
export function slotOwnershipReleaseFields(): Record<string, unknown> {
  const fields = { ...slotResetFields(false) };
  delete fields.handoff_run_id;
  return fields;
}

/**
 * Single-snapshot row read: both fields of a multi-field check come from ONE
 * file read, so a writer landing between two readSlotField calls cannot show
 * a torn view (e.g. stale owner + fresh phase).
 */
export async function readSlotRow(
  slotId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  if (!existsSync(statusFile)) return null;
  const content = await readFile(statusFile, 'utf-8');
  const data = JSON.parse(content);
  const slots: Array<Record<string, unknown>> = data.slots ?? [];
  return slots.find((s) => s.slot === slotId) ?? null;
}

/**
 * Compute-and-apply slot transition in ONE serialized write: `decide` runs
 * INSIDE the write chain against the current row, so classification and the
 * matching write cannot be split by a rival write landing between them (the
 * flaw in running one CAS attempt per possible plan). Mark-type: never bumps
 * the epoch. Fires reset listeners when the applied transition declares it
 * ends ownership (a dying owner's reviewer sessions must still end).
 */
export async function transitionSlotStatus(
  slotId: string,
  decide: (
    slot: Readonly<Record<string, unknown>>,
  ) => { fields: Record<string, unknown>; endsOwnership?: boolean } | null,
): Promise<{ applied: boolean; epoch: number | null }> {
  let applied = false;
  let epoch: number | null = null;
  let endedOwnership = false;
  const next = writeChain.then(async () => {
    if (!existsSync(statusFile)) return;
    const content = await readFile(statusFile, 'utf-8');
    const data = JSON.parse(content);
    const slots: Array<Record<string, unknown>> = data.slots ?? [];
    const slot = slots.find((s) => s.slot === slotId);
    if (!slot) return;
    const decision = decide(slot);
    if (!decision) return;
    for (const [key, value] of Object.entries(decision.fields)) {
      slot[key] = value;
    }
    await atomicWriteStatus(data);
    triggerSlotUpdateHook();
    applied = true;
    epoch = Number(slot.slot_epoch) || 0;
    endedOwnership = decision.endsOwnership === true;
  });
  writeChain = next.catch(() => {});
  await next;
  if (applied && endedOwnership) {
    for (const listener of slotResetListeners) listener(slotId);
  }
  return { applied, epoch };
}

export async function resetSlot(slotId: string, warm = false): Promise<void> {
  // Lifecycle reset DOES NOT shut down resources. Release flips the slot
  // back to `ready` but leaves the simulator / dev-server / browser alive
  // so the next run can reuse warm infra and a human-driven manual build
  // in the worktree isn't yanked out from under them. Resource shutdown
  // is a separate explicit user action via slot.cleanup (the cleanup
  // button). The previous teardown-in-resetSlot path was the source of
  // the live-sim kill problem.
  void warm; // kept for API compatibility — caller still distinguishes warm vs cold elsewhere

  // A slot mid-release belongs to that teardown: publishing it back to ready
  // hands out a slot whose windows are still being killed and whose worktree is
  // still being reset. Every path that OWNS a release (`slotRelease`,
  // `cleanupSlotAfterRunFailure`) fences the slot and finishes through
  // `resetSlotIf` under its own epoch guard, so nothing legitimate resets
  // through the fence.
  //
  // Checked and written in ONE conditional update, not read-then-write: a
  // release that fenced the slot between those two steps had its fence
  // overwritten by the unconditional write that followed. `resetSlotIf` also
  // fires the reset listeners only when the write actually applied, which is
  // what a separate pre-write loop got wrong — it ended warm reviewer sessions
  // for a reset that was then refused.
  const applied = await resetSlotIf(slotId, (slot) => slot.phase !== SLOT_PHASE_RELEASING, warm);
  if (!applied) {
    console.log(`[state] slot ${slotId} is mid-release; leaving the reset to that teardown`);
  }
}

export async function markSlotBusy(
  slotId: string,
  phase: BusyPhase,
  agent: 'idle' | 'working' = 'idle',
): Promise<void> {
  await updateSlotStatus(slotId, { lifecycle: 'busy', phase, agent });
}

export async function markSlotHeld(slotId: string, phase: HeldPhase): Promise<void> {
  await updateSlotStatus(slotId, { lifecycle: 'held', phase, agent: 'idle' });
}

export { statusFile };
