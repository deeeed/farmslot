import { safeLsGet, safeLsSet } from './storage.js';

export const PINNED_SLOTS_CHANGED = 'farmslot-pinned-slots-changed';

const KEY = 'farmslot:pinned-slots:v1';

export interface PinnedSlotPreference {
  slotId: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
}

export interface PinnedRunPreference {
  runId: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
}

export type PinnedWorkspacePreference = PinnedSlotPreference | PinnedRunPreference;
export type WorkspacePinTarget = { slotId: string } | { runId: string };

function sameTarget(pin: WorkspacePinTarget, target: WorkspacePinTarget): boolean {
  return 'slotId' in target
    ? 'slotId' in pin && pin.slotId === target.slotId
    : 'runId' in pin && pin.runId === target.runId;
}

function isPinnedSlotPreference(entry: unknown): entry is PinnedSlotPreference {
  return (
    !!entry &&
    typeof entry === 'object' &&
    'slotId' in entry &&
    typeof entry.slotId === 'string' &&
    entry.slotId.trim().length > 0 &&
    !('runId' in entry) &&
    (!('label' in entry) || typeof entry.label === 'string')
  );
}

function readRaw(): PinnedWorkspacePreference[] {
  const raw = safeLsGet(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PinnedWorkspacePreference =>
        isPinnedSlotPreference(entry) ||
        (!!entry &&
          typeof entry === 'object' &&
          typeof entry.runId === 'string' &&
          entry.runId.trim().length > 0 &&
          !('slotId' in entry) &&
          (!('label' in entry) || typeof entry.label === 'string')),
    );
  } catch {
    // Corrupt local navigation preferences are recoverable: reset them and fall back to no pins.
    safeLsSet(KEY, '[]');
    return [];
  }
}

function writeRaw(pins: PinnedWorkspacePreference[]): void {
  safeLsSet(KEY, JSON.stringify(pins));
  window.dispatchEvent(new CustomEvent(PINNED_SLOTS_CHANGED, { detail: { pins } }));
}

export function listPinnedSlots(): PinnedSlotPreference[] {
  return readRaw().filter((pin): pin is PinnedSlotPreference => 'slotId' in pin);
}

export function listPinnedWorkspaces(): PinnedWorkspacePreference[] {
  return readRaw();
}

export function isWorkspacePinned(target: WorkspacePinTarget): boolean {
  return readRaw().some((pin) => sameTarget(pin, target));
}

export function unpinWorkspace(target: WorkspacePinTarget): void {
  writeRaw(readRaw().filter((pin) => !sameTarget(pin, target)));
}

export function togglePinnedWorkspace(target: WorkspacePinTarget, label?: string): boolean {
  if (isWorkspacePinned(target)) {
    unpinWorkspace(target);
    return false;
  }
  const id = 'slotId' in target ? target.slotId : target.runId;
  if (!id.trim()) return false;
  const now = new Date().toISOString();
  writeRaw([
    ...readRaw(),
    { ...target, createdAt: now, updatedAt: now, ...(label ? { label } : {}) },
  ]);
  return true;
}

export function isSlotPinned(slotId: string): boolean {
  return isWorkspacePinned({ slotId });
}

export function pinSlot(slotId: string): void {
  const trimmed = slotId.trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  const pins = readRaw();
  const existing = pins.find((pin) => sameTarget(pin, { slotId: trimmed }));
  if (existing) {
    existing.updatedAt = now;
    writeRaw(pins);
    return;
  }
  writeRaw([...pins, { slotId: trimmed, createdAt: now, updatedAt: now }]);
}

export function unpinSlot(slotId: string): void {
  const trimmed = slotId.trim();
  if (!trimmed) return;
  unpinWorkspace({ slotId: trimmed });
}

export function setPinnedSlotLabel(slotId: string, label: string | null): void {
  const trimmed = slotId.trim();
  if (!trimmed) return;
  const cleanLabel = label?.trim() || undefined;
  const now = new Date().toISOString();
  const pins = readRaw();
  const existing = pins.find((pin) => sameTarget(pin, { slotId: trimmed }));
  if (existing) {
    existing.updatedAt = now;
    if (cleanLabel) existing.label = cleanLabel;
    else delete existing.label;
    writeRaw(pins);
    return;
  }
  writeRaw([
    {
      slotId: trimmed,
      createdAt: now,
      updatedAt: now,
      ...(cleanLabel ? { label: cleanLabel } : {}),
    },
    ...pins,
  ]);
}

export function togglePinnedSlot(slotId: string): boolean {
  if (isSlotPinned(slotId)) {
    unpinSlot(slotId);
    return false;
  }
  pinSlot(slotId);
  return true;
}
