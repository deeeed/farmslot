import { sourceObservationAge } from '@farmslot/protocol';
import {
  heldDataIsSaved,
  type ResourceQueryState,
  SUPERSEDED_READ_GRACE_MS,
} from '@farmslot/protocol/client-cache';

export interface LabelledReadObservation {
  label: string;
  observation: ResourceQueryState;
}
/**
 * Saved data worth mentioning. `connected` already includes the reconnect grace, so offline
 * past it says so at once; while connected, held data is mentioned only once its last good
 * read is older than the shared threshold. One failed or superseded reread stays silent.
 */
export function savedForDisplay(
  observation: ResourceQueryState,
  connected: boolean,
  now = Date.now(),
): boolean {
  if (!heldDataIsSaved(observation, connected, now)) return false;
  if (!connected) return true;
  const observedAt = observation.sourceObservation?.observedAt ?? observation.observedAt ?? 0;
  return now - observedAt >= SUPERSEDED_READ_GRACE_MS;
}

/** Held data typing and display keep using until it is saved data worth mentioning. */
export function heldDataUsable(
  observation: ResourceQueryState,
  connected: boolean,
  now = Date.now(),
): boolean {
  return observation.data !== undefined && !savedForDisplay(observation, connected, now);
}

/** A read error worth showing: on saved data, or when there is no data to show at all. */
export function visibleReadError(observation: ResourceQueryState, saved: boolean) {
  const error = observation.error;
  return error && (saved || observation.data === undefined) ? error : undefined;
}

/** The read error a view may show; a routine failed or superseded reread is not one. */
export function readErrorMessage(
  observation: ResourceQueryState,
  connected: boolean,
  now = Date.now(),
): string | undefined {
  return visibleReadError(observation, savedForDisplay(observation, connected, now))?.message;
}

/**
 * A connected reread in flight, or one the gateway superseded within its grace, stays quiet.
 * Offline, a read error is the outage's, which the connection banner already shows.
 */
export function resourceReadMessages(
  reads: readonly LabelledReadObservation[],
  now: number,
  connected: boolean,
): string[] {
  return reads.flatMap(({ label, observation }) => {
    if (observation.status === 'ready' || observation.status === 'loading') return [];
    const messages: string[] = [];
    const saved = savedForDisplay(observation, connected, now);
    const observedAt = observation.sourceObservation
      ? observation.sourceObservation.observedAt
      : observation.observedAt;
    if (saved && observedAt !== undefined)
      messages.push(`Saved ${label} · ${sourceObservationAge(observedAt, now)}`);
    if (observation.status === 'unsupported') messages.push(`No live ${label} updates`);
    const error = connected ? visibleReadError(observation, saved) : undefined;
    if (error) messages.push(`Could not read ${label}: ${error.message}`);
    return messages;
  });
}
