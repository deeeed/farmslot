// Live source status (ADR-069 Amendment 1, ADR-071 pilot slice). This module stays free of
// gateway state imports so the run store, node registry and server can all advance it.
import { randomUUID } from 'node:crypto';

import { Events, type ResourceChangedPayload, type Run } from '@farmslot/protocol';

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
function runSourceSignature(run: Run): string {
  return JSON.stringify([
    runSourcesSelectable(run),
    run.sourcePlan?.lock.digest ?? null,
    run.sourceProvenance?.lock.digest ?? null,
    run.sourceProvenance?.attemptId ?? null,
  ]);
}

/** Records the run's facts and returns the previous record. */
function recordRunSourceFacts(run: Run): string | undefined {
  const previous = runFacts.get(run.id);
  if (['done', 'failed', 'cancelled'].includes(run.status)) runFacts.delete(run.id);
  else runFacts.set(run.id, runSourceSignature(run));
  return previous;
}

export function noteRunSourceFacts(run: Run): void {
  if (!configured || (!run.sourcePlan && !run.sourceProvenance)) return;
  const previous = recordRunSourceFacts(run);
  if (previous !== undefined && previous !== runSourceSignature(run)) advanceSourceRevision();
}

/** run.created sets the baseline that a later run.updated, such as a cancel, is compared with. */
export function noteRunEvent(event: string, payload: unknown): void {
  if (event !== Events.RUN_UPDATED && event !== Events.RUN_CREATED) return;
  const run = (payload as { run?: Run } | undefined)?.run;
  if (run) noteRunSourceFacts(run);
}

/** A gateway write of a run's plan or provenance: one advance, which the run's next update shares. */
export function noteRunSourceWrite(run: Run): void {
  if (!configured) return;
  if (run.sourcePlan || run.sourceProvenance) recordRunSourceFacts(run);
  advanceSourceRevision();
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
