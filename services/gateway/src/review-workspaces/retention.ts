import { randomUUID } from 'node:crypto';

import { isTerminalRunStatus } from '@farmslot/protocol';

import { getQueueSnapshot } from '../backlog/dispatch-queue.js';
import { getNode } from '../fleet/machine-registry.js';
import { reviewWorkspacePendingPRs } from '../methods/pr-rules.js';
import { cancelReviewWorkspaceWorker } from '../runners/native/review-workspace.js';
import { getRunnerDefinition } from '../runners/registry.js';
import { reviewTmuxOperation } from '../runners/review-tmux.js';
import {
  getAllRuns,
  getAllRunsWithArchived,
  getRun,
  persistRunNow,
  updateRun,
} from '../runs/store.js';

import {
  reviewPR,
  reviewWorkspaceExpiry,
  workspaceRetentionProtected,
} from './retention-policy.js';
import {
  hasReviewWorkspaceRetirement,
  hasReviewWorkspaceRetirements,
  noteReviewWorkspaceRetirement,
  reclaimReviewWorkspaceStorage,
} from './storage-use.js';
import { purgeReviewWorkspace, type ReviewWorkspaceSessionCleanup } from './workspace.js';

let nextSweep = 0;

/** Existing recovery maintenance invokes this; run history is never deleted. */
export async function cleanupExpiredReviewWorkspaces(now = Date.now()): Promise<string[]> {
  if (now < nextSweep && !hasReviewWorkspaceRetirements()) return [];
  const intents = reviewWorkspacePendingPRs();
  if (!intents) return [];
  return reclaimReviewWorkspaceStorage(async () => {
    const removed: string[] = [];
    const history = await getAllRunsWithArchived();
    for (const snapshot of getAllRuns()) {
      const workspace = snapshot.reviewWorkspace;
      const expiry = reviewWorkspaceExpiry(snapshot);
      if (workspace?.cleanedAt) {
        if (hasReviewWorkspaceRetirement(snapshot.id)) {
          await persistRunNow(snapshot, 'retry durable review workspace closeout');
          noteReviewWorkspaceRetirement(snapshot, true);
          removed.push(workspace.checkoutPath);
        }
        continue;
      }
      if (!workspace?.retainedAt || !expiry || now < Date.parse(expiry)) continue;
      if (workspace.executionNodeId !== 'local' && !getNode(workspace.executionNodeId)) continue;
      const pending = () => {
        const requests = reviewWorkspacePendingPRs();
        if (!requests) throw new Error('Review intake state is not available for cleanup');
        return [
          ...getQueueSnapshot({ forRetention: true }).filter(
            (item) =>
              item.flowType === 'review-pr' && ['queued', 'dispatching'].includes(item.status),
          ),
          ...requests.map((pr) => ({ ticketOrPr: `${pr.repo}#${pr.number}` })),
        ];
      };
      const check = () => {
        const current = getRun(snapshot.id);
        if (
          !current ||
          current.reviewWorkspace?.workspaceId !== workspace.workspaceId ||
          workspaceRetentionProtected(current, getAllRuns(), pending())
        )
          throw new Error(
            'Review workspace retention is protected by an active or pending PR review',
          );
      };
      if (workspaceRetentionProtected(snapshot, getAllRuns(), pending())) continue;
      try {
        check();
        if (!workspace.retirement) {
          if (snapshot.transport === 'native') await cancelReviewWorkspaceWorker(snapshot.id);
          else if (snapshot.agentContexts?.some((context) => context.target))
            await reviewTmuxOperation(snapshot, 'stop');
        }
        check();
        const current = getRun(snapshot.id)!;
        const context = current.agentContexts?.find((c) => c.id === 'review');
        const sessionId = context?.runnerSessionId;
        const shared =
          sessionId &&
          getAllRuns().some(
            (other) =>
              other.id !== current.id &&
              other.agentContexts?.some(
                (c) => c.runner === context?.runner && c.runnerSessionId === sessionId,
              ) &&
              (!isTerminalRunStatus(other.status) ||
                (!other.reviewWorkspace?.cleanedAt &&
                  (!reviewWorkspaceExpiry(other) ||
                    now < Date.parse(reviewWorkspaceExpiry(other)!)))),
          );
        if (
          shared &&
          [context?.runnerSessionPath, context?.nativeSession?.stateDirectory].some((file) =>
            file?.includes('/runs/' + workspace.workspaceId + '/'),
          )
        )
          continue;
        let session: ReviewWorkspaceSessionCleanup | undefined;
        if (!shared && context) {
          const native = context.nativeSession;
          session = {
            runnerSessionId: sessionId ?? undefined,
            ...(getRunnerDefinition(context.runner).workspaceSessionFileCleanup
              ? {
                  format: getRunnerDefinition(context.runner).workspaceSessionFileCleanup,
                  path: context.runnerSessionPath ?? undefined,
                }
              : {}),
            ...(native?.closedAt && native.stateDirectory
              ? {
                  stateDirectory: native.stateDirectory,
                  nativeSessionId: native.sessionId,
                  ownerPrincipalId: native.ownerPrincipalId,
                }
              : {}),
            cwd: workspace.checkoutPath,
            cwds: history
              .filter(
                (other) =>
                  other.nativeOwnerPrincipalId === current.nativeOwnerPrincipalId &&
                  other.agentContexts?.some(
                    (c) => c.runner === context.runner && c.runnerSessionId === sessionId,
                  ),
              )
              .flatMap((other) =>
                other.reviewWorkspace ? [other.reviewWorkspace.checkoutPath] : [],
              ),
          };
        }
        if (!getRun(current.id)!.reviewWorkspace!.retirement) {
          const pr = reviewPR(current);
          if (!pr)
            throw new Error('Review PR identity is unavailable for the durable cleanup fence');
          updateRun(current.id, {
            reviewWorkspace: {
              ...getRun(current.id)!.reviewWorkspace!,
              retirement: { id: randomUUID(), startedAt: new Date(now).toISOString(), pr },
            },
          });
        }
        // A previous write may have failed after installing the in-memory marker.
        // Recheck its durability on every attempt before sending a destructive node command.
        await persistRunNow(
          getRun(current.id)!,
          'checkpoint review workspace retirement before node deletion',
        );
        await purgeReviewWorkspace(current.id, {
          assertCurrent: check,
          session,
        });
        check();
        await persistRunNow(
          updateRun(current.id, {
            reviewWorkspace: {
              ...getRun(current.id)!.reviewWorkspace!,
              cleanedAt: new Date(now).toISOString(),
            },
            reviewWorkspaceCleanupError: undefined,
          }),
          'expired review workspace reclaimed',
        );
        noteReviewWorkspaceRetirement(getRun(current.id)!, true);
        removed.push(workspace.checkoutPath);
      } catch (error) {
        // The files stay owned and visible until a later maintenance pass can confirm closure/deletion.
        const message = error instanceof Error ? error.message : String(error);
        const current = getRun(snapshot.id);
        if (current?.reviewWorkspace?.cleanedAt && hasReviewWorkspaceRetirement(current.id)) {
          // Node deletion is confirmed. Keep admission fenced until its metadata reaches disk.
          await persistRunNow(
            current,
            'retry durable review workspace closeout after node deletion',
          );
          noteReviewWorkspaceRetirement(current, true);
          removed.push(workspace.checkoutPath);
          continue;
        }
        if (current && current.reviewWorkspaceCleanupError !== message)
          await persistRunNow(
            updateRun(current.id, { reviewWorkspaceCleanupError: message }),
            'retained review cleanup deferred',
          );
      }
    }
    nextSweep = now + 300000;
    return removed;
  });
}
