// Entity versions (ADR-071 Amendments 1 and 3): slots, machines, PRs and run-list rows share one
// content version, the full sha256 hex of the entity's canonical JSON.
import { createHash } from 'node:crypto';

import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

/** The entity's content version; the client cache derives the same digest to verify a body. */
export function entityVersionHash(entity: object): string {
  return createHash('sha256').update(canonicalResourceJson(entity)).digest('hex');
}
