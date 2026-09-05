/**
 * A place for the code that actually starts or stops a slot resource to say so.
 *
 * Machine parking needs to know what a restore did to each resource. It cannot
 * infer that: a boot that succeeds leaves no error behind, and comparing an
 * observation before an operation with one after it misses a restart of a
 * resource that was already running, and cannot attribute anything when two
 * things move at once. So the one function that runs a resource's boot,
 * shutdown, or relaunch hook reports what it ran, and whoever cares subscribes.
 *
 * The capability acquire path reaches the same function, which is the point:
 * a provider whose acquire action is its resource's own boot shows up here
 * exactly like a direct boot does.
 */
export type SlotResourceLifecycleAction = 'boot' | 'shutdown' | 'relaunch';

export interface SlotResourceLifecycleRecord {
  slotId: string;
  resourceId: string;
  action: SlotResourceLifecycleAction;
  ok: boolean;
  detail?: string;
}

type Listener = (record: SlotResourceLifecycleRecord) => void;

/** At most one listener per slot; a restore owns its slot for its duration. */
const listeners = new Map<string, Listener>();

/**
 * Listen to every resource lifecycle action on one slot until the returned
 * function is called. Always stop in a `finally`: a listener left behind would
 * attribute a later occupant's boots to a finished restore.
 */
export function captureSlotResourceLifecycle(slotId: string, listener: Listener): () => void {
  listeners.set(slotId, listener);
  return () => {
    if (listeners.get(slotId) === listener) listeners.delete(slotId);
  };
}

/** Called by the code that ran the hook, with what it ran and how it went. */
export function reportSlotResourceLifecycle(record: SlotResourceLifecycleRecord): void {
  listeners.get(record.slotId)?.(record);
}
