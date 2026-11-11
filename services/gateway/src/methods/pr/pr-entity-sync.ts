/**
 * Entity-sync handlers for pr.list (ADR-071 Amendment 3).
 * Routes: pr.list { versions: true } and pr.list { ids: string[] }.
 */
import type { PREntityPage, PRStatus, PRVersionsResult } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';
import type { ChangedEntity } from '@farmslot/protocol/transport/events';

import { GatewayMethodError } from '../../core/method-error.js';

import { getCollectorSnapshotByQueryId, prListResourceKey } from './list-cache.js';
import { prEntityVersion, prPrKey } from './pr-entity-keys.js';

const PAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Synchronous entity provider for all upstream/github per-PR keys.
 * A single instance handles all project scopes: it reads queryId from the key.
 * Collection keys (no prKey) are skipped — they carry no entity.
 * Registered at startup by server.ts for the 'upstream' family.
 */
export function prEntityProvider(): (key: ResourceKey) => ChangedEntity | undefined {
  return (key: ResourceKey): ChangedEntity | undefined => {
    if (key.family !== 'upstream' || !('integration' in key) || key.integration !== 'github')
      return undefined;
    if (!('prKey' in key)) return undefined; // collection key — skip
    const typedKey = key as { queryId: string; prKey: string };
    const snapshot = getCollectorSnapshotByQueryId(typedKey.queryId);
    if (!snapshot) return undefined;
    const slashIdx = typedKey.prKey.lastIndexOf('/');
    if (slashIdx < 0) return undefined;
    const repo = typedKey.prKey.slice(0, slashIdx);
    const prNum = typedKey.prKey.slice(slashIdx + 1);
    const pr = snapshot.prs.find((p) => p.repo === repo && String(p.pr) === prNum);
    if (!pr) return undefined;
    return { family: 'upstream', entity: pr, version: prEntityVersion(pr) };
  };
}

/**
 * pr.list { versions: true }
 * Returns id/version pairs plus non-entity fields (fetchedAt, truncated).
 */
export async function prListVersions(project?: string): Promise<PRVersionsResult> {
  const collectionKey = prListResourceKey(project);
  const queryId = (collectionKey as { queryId: string }).queryId;
  const snapshot = getCollectorSnapshotByQueryId(queryId);
  if (!snapshot) {
    throw new GatewayMethodError('NOT_READY', 'PR list not yet available');
  }
  const versions = snapshot.prs.map((pr) => ({
    id: prPrKey(pr),
    version: prEntityVersion(pr),
  }));
  return {
    versions,
    ...(snapshot.fetchedAt ? { fetchedAt: snapshot.fetchedAt } : {}),
    ...(snapshot.truncated ? { truncated: snapshot.truncated } : {}),
  };
}

/**
 * pr.list { ids: string[] }
 * Returns only the named PR entities (by prKey `${repo}/${pr}`) plus their versions.
 */
export async function prListIds(project: string | undefined, ids: string[]): Promise<PREntityPage> {
  const collectionKey = prListResourceKey(project);
  const queryId = (collectionKey as { queryId: string }).queryId;
  const snapshot = getCollectorSnapshotByQueryId(queryId);
  if (!snapshot) {
    throw new GatewayMethodError('NOT_READY', 'PR list not yet available');
  }
  const prMap = new Map<string, PRStatus>();
  for (const pr of snapshot.prs) prMap.set(prPrKey(pr), pr);

  const entities: PRStatus[] = [];
  const versions: Array<{ id: string; version: string }> = [];
  let bytes = 0;

  for (const id of ids) {
    const pr = prMap.get(id);
    if (!pr) continue;
    const version = prEntityVersion(pr);
    const entryBytes = JSON.stringify(pr).length;
    if (bytes + entryBytes > PAGE_MAX_BYTES && entities.length > 0) break;
    bytes += entryBytes;
    entities.push(pr);
    versions.push({ id, version });
  }
  return { entities, versions };
}
