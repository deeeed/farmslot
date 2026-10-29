import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { resourceRevisions } from './revisions.js';

type PlanningCollection = Extract<ResourceKey, { family: 'planning' }>['collection'];

/** Owning stores publish after their new collection and detail state is readable. */
export function publishPlanningResources(
  collection: PlanningCollection,
  itemId?: string,
  kind: 'updated' | 'deleted' = 'updated',
  revisions = resourceRevisions,
): void {
  // A filtered query still depends on collection membership, including project moves.
  revisions.advance({ family: 'planning', collection });
  if (itemId) revisions.advance({ family: 'planning', collection, itemId }, kind);
}
