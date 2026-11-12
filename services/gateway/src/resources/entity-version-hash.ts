// Entity versions (ADR-071 Amendment 4): a slot, machine or PR is versioned by the full sha256 hex
// of its canonical JSON, the digest the run list uses for its rows.
import { createHash } from 'node:crypto';

import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

/** The entity's content version; the client cache derives the same digest to verify a body. */
export function entityVersionHash(entity: object): string {
  return createHash('sha256').update(canonicalResourceJson(entity)).digest('hex');
}
