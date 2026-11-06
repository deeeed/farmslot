import { AsyncLocalStorage } from 'node:async_hooks';

import {
  isTerminalRunStatus,
  type MonitoredPRIdentity,
  nativeWorkerBindingIsHeld,
  type Run,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { reviewPR } from './retention-policy.js';

export function runNeedsExecutionStorage(run: Run): boolean {
  return (
    (!run.archivedAt && !isTerminalRunStatus(run.status)) ||
    run.decisions.some((decision) => !decision.resolvedAt) ||
    Boolean(run.reviewWorkspace && !run.reviewWorkspace.cleanedAt) ||
    Boolean(run.output?.cleanupPending || run.output?.closeError) ||
    Boolean(
      run.agentContexts?.some(
        (context) => context.nativeSession && nativeWorkerBindingIsHeld(context.nativeSession),
      ),
    )
  );
}

// Allocations run concurrently; reclamation starts only at an idle storage boundary.
let users = 0;
let reclamation: Promise<void> | undefined;
const reclamationOwner = new AsyncLocalStorage<Promise<void>>();

const retiringPRs = new Map<string, MonitoredPRIdentity | null>();
const prKey = (pr: MonitoredPRIdentity) =>
  `${pr.host.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;

/** Hydrated by the run store before serving requests, and refreshed on every binding mutation. */
export function noteReviewWorkspaceRetirement(
  run: Pick<Run, 'id' | 'ticketOrPr' | 'prWork' | 'reviewWorkspace'>,
): void {
  const marker = run.reviewWorkspace?.retirement;
  if (marker && !run.reviewWorkspace?.cleanedAt)
    retiringPRs.set(run.id, marker.pr ?? reviewPR(run));
  else retiringPRs.delete(run.id);
}
export function hasReviewWorkspaceRetirements(): boolean {
  return retiringPRs.size > 0;
}

/** A durable PR-specific fence survives a gateway restart while node deletion finishes. */
export function assertReviewWorkspaceAdmissionOpen(
  scope?: Pick<Run, 'ticketOrPr' | 'prWork'> | MonitoredPRIdentity,
): void {
  const pr = scope ? ('ticketOrPr' in scope ? reviewPR(scope) : scope) : null;
  if (
    reclamation ||
    [...retiringPRs.values()].some((retiring) => !pr || !retiring || prKey(retiring) === prKey(pr))
  )
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_CLEANUP_PENDING',
      'Review workspace cleanup is running; retry review admission after cleanup finishes',
    );
}

export async function useReviewWorkspaceStorage<T>(operation: () => Promise<T>): Promise<T> {
  if (reclamation && reclamationOwner.getStore() === reclamation) return operation();
  while (reclamation) await reclamation;
  users++;
  try {
    return await operation();
  } finally {
    users--;
  }
}

export async function reclaimReviewWorkspaceStorage(
  operation: () => Promise<string[]>,
): Promise<string[]> {
  while (reclamation) await reclamation;
  // An in-flight admission may have frozen a digest without publishing its run binding yet.
  if (users) return [];
  let release!: () => void;
  reclamation = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    return await reclamationOwner.run(reclamation, operation);
  } finally {
    reclamation = undefined;
    release();
  }
}
