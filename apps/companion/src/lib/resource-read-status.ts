import { sourceObservationAge } from '@farmslot/protocol';
import {
  heldDataIsSaved,
  isSupersededRead,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

export interface LabelledReadObservation {
  label: string;
  observation: ResourceQueryState;
}
/** A read error worth showing: a read the gateway superseded within its grace is not one. */
export function visibleReadError(observation: ResourceQueryState, saved: boolean) {
  const error = observation.error;
  return error && (saved || observation.data === undefined || !isSupersededRead(error))
    ? error
    : undefined;
}

/** A connected reread in flight, or one the gateway superseded within its grace, stays quiet. */
export function resourceReadMessages(
  reads: readonly LabelledReadObservation[],
  now: number,
  connected: boolean,
): string[] {
  return reads.flatMap(({ label, observation }) => {
    if (observation.status === 'ready' || observation.status === 'loading') return [];
    const messages: string[] = [];
    const saved = heldDataIsSaved(observation, connected, now);
    const observedAt = observation.sourceObservation
      ? observation.sourceObservation.observedAt
      : observation.observedAt;
    if (saved && observedAt !== undefined)
      messages.push(
        `Saved ${label}, ${sourceObservationAge(observedAt, now)}. Actions wait for a current read.`,
      );
    if (observation.status === 'unsupported')
      messages.push(`Live ${label} updates are unavailable on this gateway.`);
    const error = visibleReadError(observation, saved);
    if (error) messages.push(`Could not read ${label}: ${error.message}`);
    return messages;
  });
}
