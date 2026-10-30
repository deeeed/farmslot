import { sourceObservationAge } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

export interface LabelledReadObservation {
  label: string;
  observation: ResourceQueryState;
}
export function resourceReadMessages(
  reads: readonly LabelledReadObservation[],
  now: number,
): string[] {
  return reads.flatMap(({ label, observation }) => {
    if (observation.status === 'ready' || observation.status === 'loading') return [];
    const messages: string[] = [];
    const observedAt = observation.sourceObservation
      ? observation.sourceObservation.observedAt
      : observation.observedAt;
    if (observation.status === 'stale' && observedAt !== undefined)
      messages.push(
        `Saved ${label}, ${sourceObservationAge(observedAt, now)}. Actions wait for a current read.`,
      );
    if (observation.status === 'unsupported')
      messages.push(`Live ${label} updates are unavailable on this gateway.`);
    if (observation.error) messages.push(`Could not read ${label}: ${observation.error.message}`);
    return messages;
  });
}
