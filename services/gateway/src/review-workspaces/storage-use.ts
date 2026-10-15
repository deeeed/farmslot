import { isTerminalRunStatus, nativeWorkerBindingIsHeld, type Run } from '@farmslot/protocol';

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

// Allocations can run concurrently; reclamation waits for an idle storage boundary.
let users = 0;
let reclamation: Promise<void> | undefined;

export async function useReviewWorkspaceStorage<T>(operation: () => Promise<T>): Promise<T> {
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
    return await operation();
  } finally {
    reclamation = undefined;
    release();
  }
}
