import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A place for the code that actually starts or stops a slot resource to say so,
 * attributed to the operation that asked for it.
 *
 * Machine parking needs to know what a restore did to each resource. It cannot
 * infer that: a boot that succeeds leaves no error behind, and comparing an
 * observation before an operation with one after it misses a restart of a
 * resource that was already running. So the one function that runs a resource's
 * boot, shutdown, or relaunch hook reports what it ran.
 *
 * Attribution is by execution context, not by slot. `resource.control`, the
 * chat tool's resource control, and cleanup shutdowns all reach that same
 * function without the machine lock a restore holds, so an operator booting a
 * resource mid-restore would otherwise be recorded as something the restore
 * did — and for a retained resource that would fail the restore over an action
 * it never took. The context id set around the restore rides the async call
 * chain, so only work the restore itself initiated carries it, including a
 * capability acquire that reaches the hook several layers down. A hook started
 * before the capture began has no such id and is not attributed either.
 *
 * The failure mode is deliberately one-sided: work whose context is lost goes
 * unattributed rather than misattributed. An effect the record misses is a gap;
 * an effect it invents is a false accusation.
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

const contexts = new AsyncLocalStorage<string>();
const listeners = new Map<string, { slotId: string; listener: Listener }>();

/**
 * Run `operation` under `contextId`, so every resource hook it reaches reports
 * against it. Nothing outside this call, concurrent or earlier, carries the id.
 */
export function runWithResourceLifecycleContext<T>(
  contextId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return contexts.run(contextId, operation);
}

/**
 * Hear the resource hooks that `contextId` runs against `slotId`, until the
 * returned function is called. Call it in a `finally`: the id never recurs, so
 * a listener left behind cannot catch a later operation's hooks, but it does
 * hold its closure — and the record it writes into — for the life of the
 * process.
 */
export function captureSlotResourceLifecycle(
  scope: { contextId: string; slotId: string },
  listener: Listener,
): () => void {
  const entry = { slotId: scope.slotId, listener };
  listeners.set(scope.contextId, entry);
  return () => {
    if (listeners.get(scope.contextId) === entry) listeners.delete(scope.contextId);
  };
}

/** Called by the code that ran the hook, with what it ran and how it went. */
export function reportSlotResourceLifecycle(record: SlotResourceLifecycleRecord): void {
  const contextId = contexts.getStore();
  if (contextId === undefined) return;
  const entry = listeners.get(contextId);
  if (!entry || entry.slotId !== record.slotId) return;
  entry.listener(record);
}

/** Test-only: how many captures are still installed. Zero after a clean exit. */
export function activeResourceLifecycleCaptures(): number {
  return listeners.size;
}
