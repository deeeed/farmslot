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
/** A connected reread in flight, or one the gateway superseded within its grace, stays quiet. */
export function resourceReadMessages(
  reads: readonly LabelledReadObservation[],
  now: number,
  connected = true,
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
    if (
      observation.error &&
      (saved || observation.data === undefined || !isSupersededRead(observation.error))
    )
      messages.push(`Could not read ${label}: ${observation.error.message}`);
    return messages;
  });
}
