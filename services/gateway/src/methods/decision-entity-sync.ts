/**
 * Entity-sync handlers for decision.list (ADR-071 Amendment 3).
 * Routes: decision.list { versions: true } and decision.list { ids: string[] }.
 */
import type {
  DecisionEntityPage,
  DecisionVersionsResult,
  PendingDecision,
} from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';
import type { ChangedEntity } from '@farmslot/protocol/transport/events';

import { GatewayMethodError } from '../core/method-error.js';
import { decisionIndex } from '../decisions/index.js';

const PAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Synchronous entity provider for per-decision resource keys.
 * Registered at startup by server.ts for the 'decision' family.
 */
export function decisionEntityProvider(): (key: ResourceKey) => ChangedEntity | undefined {
  return (key: ResourceKey): ChangedEntity | undefined => {
    if (key.family !== 'decision' || !('decisionId' in key)) return undefined;
    const typedKey = key as { decisionId: string };
    const entity = decisionIndex.get(typedKey.decisionId);
    const version = decisionIndex.getVersion(typedKey.decisionId);
    if (!entity || !version) return undefined;
    return { family: 'decision', entity, version };
  };
}

/**
 * decision.list { versions: true }
 * Returns id/version pairs for all live decisions.
 */
export async function decisionListVersions(): Promise<DecisionVersionsResult> {
  await decisionIndex.ready();
  return { versions: decisionIndex.getAllVersions() };
}

/**
 * decision.list { ids: string[] }
 * Returns only the named decision entities plus their versions.
 */
export async function decisionListIds(ids: string[]): Promise<DecisionEntityPage> {
  await decisionIndex.ready();
  if (!ids.length) throw new GatewayMethodError('INVALID_PARAMS', 'ids must be non-empty');

  const entities: PendingDecision[] = [];
  const versions: Array<{ id: string; version: string }> = [];
  let bytes = 0;

  for (const id of ids) {
    const entity = decisionIndex.get(id);
    if (!entity) continue;
    const version = decisionIndex.getVersion(id);
    if (!version) continue;
    const entryBytes = JSON.stringify(entity).length;
    if (bytes + entryBytes > PAGE_MAX_BYTES && entities.length > 0) break;
    bytes += entryBytes;
    entities.push(entity);
    versions.push({ id, version });
  }
  return { entities, versions };
}
