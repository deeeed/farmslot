// Live source status (ADR-069 Amendment 1, ADR-071 pilot slice). This module stays free of
// gateway state imports so the run store, node registry and server can all advance it.
import { randomUUID } from 'node:crypto';

import type { ResourceChangedPayload, Run } from '@farmslot/protocol';

import { runSourcesSelectable } from './pin-target.js';

const epoch = randomUUID();
let revision = 0;
let configured = false;
let publisher: (() => void) | undefined;
let publishScheduled = false;
let authorityFacts: string | undefined;
const runFacts = new Map<string, string>();
const materialized = new Set<string>();

/** The current payload, absent until source declarations are configured. */
export function currentSourceResourceChanges(): ResourceChangedPayload | undefined {
  if (!configured) return undefined;
  return {
    version: 1,
    epoch,
    changes: [{ key: { family: 'sources', scope: 'farm' }, revision, kind: 'updated' }],
  };
}

export function announceSourceChanges(): void {
  configured = true;
}

/** Broadcasts `fleet.updated`; set once by the server that owns the sockets. */
export function setSourceChangePublisher(publish: () => void): void {
  publisher = publish;
}

/** Callers advance only after the change is readable through `sources.status`. */
export function advanceSourceRevision(): void {
  if (!configured) return;
  revision++;
  if (publishScheduled) return;
  // Coalesce a burst of writes into one notice carrying the highest revision.
  publishScheduled = true;
  setImmediate(() => {
    publishScheduled = false;
    publisher?.();
  });
}

/** Authority-owned facts, compared without poll timestamps so idle polls stay quiet. */
export function noteAuthorityFacts(signature: string): void {
  const previous = authorityFacts;
  authorityFacts = signature;
  if (previous !== undefined && previous !== signature) advanceSourceRevision();
}

/** Run facts that `sources.status` reports for a run: its plan, lock and pin eligibility. */
export function noteRunSourceFacts(run: Run): void {
  if (!configured || (!run.sourcePlan && !run.sourceProvenance)) return;
  const signature = JSON.stringify([
    runSourcesSelectable(run),
    run.sourcePlan?.lock.digest ?? null,
    run.sourceProvenance?.lock.digest ?? null,
    run.sourceProvenance?.attemptId ?? null,
  ]);
  const previous = runFacts.get(run.id);
  if (['done', 'failed', 'cancelled'].includes(run.status)) runFacts.delete(run.id);
  else runFacts.set(run.id, signature);
  if (previous !== undefined && previous !== signature) advanceSourceRevision();
}

/**
 * A node publishes a lock's receipt once, on its first materialization; repeats only
 * verify it. Locks persist before materialization finishes, so its receipt needs its own.
 */
export function noteSourceMaterialized(nodeId: string, lockDigest: string): void {
  const key = `${nodeId}\0${lockDigest}`;
  if (!configured || materialized.has(key)) return;
  materialized.add(key);
  advanceSourceRevision();
}

/** Test hook: the same process-level state the gateway uses. */
export function resetSourceChangeSignalForTests(): void {
  revision = 0;
  configured = false;
  publisher = undefined;
  publishScheduled = false;
  authorityFacts = undefined;
  runFacts.clear();
  materialized.clear();
}
