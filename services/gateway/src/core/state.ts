// core/state.ts — .farm-status.json state management
// TypeScript port of lib/slot-common.sh: update_farm_status

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { farmslotRoot } from './config.js';

const statusFile = path.join(farmslotRoot, '.farm-status.json');

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
    if (!existsSync(statusFile)) return;
    const content = await readFile(statusFile, 'utf-8');
    const data = JSON.parse(content);
    const slots: Array<Record<string, unknown>> = data.slots ?? [];
    const slot = slots.find((s) => s.slot === slotId);
    if (!slot) return;
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

export async function resetSlot(slotId: string, warm = false): Promise<void> {
  // Lifecycle reset DOES NOT shut down resources. Release flips the slot
  // back to `ready` but leaves the simulator / dev-server / browser alive
  // so the next run can reuse warm infra and a human-driven manual build
  // in the worktree isn't yanked out from under them. Resource shutdown
  // is a separate explicit user action via slot.cleanup (the cleanup
  // button). The previous teardown-in-resetSlot path was the source of
  // the live-sim kill problem.
  void warm; // kept for API compatibility — caller still distinguishes warm vs cold elsewhere

  // Slot release ends any warm reviewer sessions that lived on this slot — a
  // later run must never resume a prior run's reviewer context. Listener
  // registration (see initSelfReview) keeps core/ free of upward imports.
  for (const listener of slotResetListeners) listener(slotId);

  await updateSlotStatus(slotId, {
    lifecycle: 'ready',
    phase: null,
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
  });
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
