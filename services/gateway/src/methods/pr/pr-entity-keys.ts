/**
 * Pure key and version functions for PR entity-sync (ADR-071 Amendment 3).
 * No dependency on list-cache; imported by both list-cache and pr-entity-sync.
 */
import { createHash } from 'node:crypto';

import type { PRStatus } from '@farmslot/protocol';
import { canonicalResourceJson, type ResourceKey } from '@farmslot/protocol/client-cache';

/** prKey is `${repo}/${pr}` — unique within a queryId scope. */
export function prPrKey(pr: PRStatus): string {
  return `${pr.repo}/${pr.pr}`;
}

/** Per-PR entity key for entity-sync. */
export function prEntityKey(queryId: string, pr: PRStatus): ResourceKey {
  return { family: 'upstream', integration: 'github', queryId, prKey: prPrKey(pr) };
}

/** Content-hash version for a PR entity. Stable across gateway restarts. */
export function prEntityVersion(pr: PRStatus): string {
  return createHash('sha256').update(canonicalResourceJson(pr)).digest('hex').slice(0, 16);
}
