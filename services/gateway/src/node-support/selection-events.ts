/**
 * Selecting activations, as they start and end. The node selects the new
 * bundle and may prune the one the slot selected before inside the activation,
 * before the gateway hears back, so anything that cached that earlier bundle's
 * directory for the slot must stop using it from the start. A module of its
 * own: tests that mock ensure.js with explicit export lists never shadow it.
 */
export interface SelectionListener {
  started(slotId: string): void;
  /** `supportDir` is null when the activation failed: the node may or may not have moved. */
  ended(slotId: string, supportDir: string | null): void;
}

const listeners = new Set<SelectionListener>();

export function onNodeSupportSelection(listener: SelectionListener): void {
  listeners.add(listener);
}

export function notifyNodeSupportSelectionStarted(slotId: string): void {
  for (const listener of listeners) listener.started(slotId);
}

export function notifyNodeSupportSelectionEnded(slotId: string, supportDir: string | null): void {
  for (const listener of listeners) listener.ended(slotId, supportDir);
}
