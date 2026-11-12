/**
 * Shared entity version hash for entity-sync (ADR-071 Amendment 3).
 *
 * All four entity types (fleet nodes, PRs, run list rows, decisions) use the
 * same full sha256 hex (64 chars) of their canonical JSON.  Import this helper
 * instead of inlining the hash call.
 */
import { createHash } from 'node:crypto';

import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

/** Content-hash version for an entity.  Full sha256 hex (64 chars). */
export function entityVersionHash(entity: object): string {
  return createHash('sha256').update(canonicalResourceJson(entity)).digest('hex');
}
