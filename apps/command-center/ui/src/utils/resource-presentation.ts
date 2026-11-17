import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

/** Read metadata still advances for waiters; equal displayed facts need no Lit update. */
export function resourcePresentationChanged(
  next: ResourceQueryState,
  previous?: ResourceQueryState,
): boolean {
  return (
    !previous ||
    next.data !== previous.data ||
    next.status !== previous.status ||
    next.error?.code !== previous.error?.code ||
    next.error?.message !== previous.error?.message ||
    next.storageNotice !== previous.storageNotice ||
    next.resourceState?.epoch !== previous.resourceState?.epoch ||
    next.sourceObservation?.status !== previous.sourceObservation?.status ||
    next.sourceObservation?.error?.code !== previous.sourceObservation?.error?.code ||
    next.sourceObservation?.error?.message !== previous.sourceObservation?.error?.message ||
    (next.status !== 'ready' &&
      (next.observedAt !== previous.observedAt ||
        next.sourceObservation?.observedAt !== previous.sourceObservation?.observedAt)) ||
    next.conversation !== previous.conversation ||
    next.catchUpProgress?.done !== previous.catchUpProgress?.done ||
    next.catchUpProgress?.total !== previous.catchUpProgress?.total
  );
}
