/**
 * Told each time a slot's selection moves to a bundle. The node may then prune
 * the bundle the slot selected before, so anything that cached that bundle's
 * directory for the slot must stop using it. A module of its own: tests that
 * mock ensure.js with explicit export lists never shadow it.
 */
type SelectionListener = (slotId: string, supportDir: string) => void;

const listeners = new Set<SelectionListener>();

export function onNodeSupportSelection(listener: SelectionListener): void {
  listeners.add(listener);
}

export function notifyNodeSupportSelection(slotId: string, supportDir: string): void {
  for (const listener of listeners) listener(slotId, supportDir);
}
