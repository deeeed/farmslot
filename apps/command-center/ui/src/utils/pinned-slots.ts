import { safeLsGet, safeLsSet } from './storage.js';

export const PINNED_SLOTS_CHANGED = 'farmslot-pinned-slots-changed';

const KEY = 'farmslot:pinned-slots:v1';

export interface PinnedSlotPreference {
  slotId: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
}

function isPinnedSlotPreference(entry: unknown): entry is PinnedSlotPreference {
  return (
    !!entry &&
    typeof entry === 'object' &&
    'slotId' in entry &&
    typeof entry.slotId === 'string' &&
    (!('label' in entry) || typeof entry.label === 'string')
  );
}

function readRaw(): PinnedSlotPreference[] {
  const raw = safeLsGet(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPinnedSlotPreference);
  } catch {
    // Corrupt local navigation preferences are recoverable: reset them and fall back to no pins.
    safeLsSet(KEY, '[]');
    return [];
  }
}

function writeRaw(pins: PinnedSlotPreference[]): void {
  safeLsSet(KEY, JSON.stringify(pins));
  window.dispatchEvent(new CustomEvent(PINNED_SLOTS_CHANGED, { detail: { pins } }));
}

export function listPinnedSlots(): PinnedSlotPreference[] {
  return readRaw();
}

export function isSlotPinned(slotId: string): boolean {
  return readRaw().some((pin) => pin.slotId === slotId);
}

export function pinSlot(slotId: string): void {
  const trimmed = slotId.trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  const pins = readRaw();
  const existing = pins.find((pin) => pin.slotId === trimmed);
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
  writeRaw(readRaw().filter((pin) => pin.slotId !== trimmed));
}

export function setPinnedSlotLabel(slotId: string, label: string | null): void {
  const trimmed = slotId.trim();
  if (!trimmed) return;
  const cleanLabel = label?.trim() || undefined;
  const now = new Date().toISOString();
  const pins = readRaw();
  const existing = pins.find((pin) => pin.slotId === trimmed);
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
