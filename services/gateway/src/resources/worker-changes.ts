import type { NodeTmuxPane } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { type GatewayResourceRevisions, resourceRevisions } from './revisions.js';

export const WORKER_SIGNAL_FRESH_MS = 120_000;
export const WORKER_PANE_RECENT_CHANGE_MS = 30_000;

function workerKeys(nodeId?: string): ResourceKey[] {
  return [
    { family: 'workers', scope: 'farm' },
    ...(nodeId ? [{ family: 'workers' as const, nodeId }] : []),
  ];
}

/** Owning writers call this only after the replacement source is readable. */
export function publishWorkerResources(nodeId?: string, revisions = resourceRevisions): void {
  for (const key of workerKeys(nodeId)) revisions.advance(key);
}

/** A semantic freshness transition is a deadline, not a recurring inventory read. */
export function nextWorkerStatusExpiry(
  panes: readonly NodeTmuxPane[],
  now = Date.now(),
): number | undefined {
  const deadlines = panes
    .flatMap((pane) => [
      pane.lastChangedAt == null
        ? undefined
        : pane.lastChangedAt + WORKER_PANE_RECENT_CHANGE_MS + 1,
      ...Object.values(pane.signals ?? {}).map((signal) =>
        signal?.observedAt == null ? undefined : signal.observedAt + WORKER_SIGNAL_FRESH_MS + 1,
      ),
    ])
    .filter((at): at is number => at !== undefined && Number.isFinite(at) && at > now);
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

export function scheduleWorkerStatusExpiry(
  nodeId: string,
  panes: readonly NodeTmuxPane[],
  revisions: GatewayResourceRevisions = resourceRevisions,
): void {
  revisions.scheduleInvalidations(
    `worker-status:${nodeId}`,
    workerKeys(nodeId),
    nextWorkerStatusExpiry(panes),
  );
}
