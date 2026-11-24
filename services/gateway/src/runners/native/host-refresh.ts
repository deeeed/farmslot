import {
  isReviewerAgentRole,
  isTerminalRunStatus,
  type NativeSessionInfo,
  type Run,
} from '@farmslot/protocol';

/**
 * Idle gateway-local sessions a host refresh must not stop, with the reason. A refresh stops
 * idle runners and their next use resumes the saved identity: on their own for warm reviewers,
 * review-fix and worker messages; from the user's own surface for Command Center chat and the
 * Co-Pilot. An active run's static review workspace (operator replay) and its dev worker (the
 * monitor's resume decision) would wait for a person instead, so they keep the host running.
 */
export function sessionsNeedingAPerson(
  runs: readonly Run[],
  sessions: readonly Pick<NativeSessionInfo, 'id'>[],
): Map<string, string> {
  const live = new Set(sessions.map((session) => session.id));
  const kept = new Map<string, string>();
  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) continue;
    for (const context of run.agentContexts ?? []) {
      const binding = context.nativeSession;
      if (!binding || !live.has(binding.sessionId)) continue;
      if ((binding.executionNodeId ?? 'local') !== 'local') continue;
      if (run.reviewWorkspaceTarget)
        kept.set(binding.sessionId, `static review workspace of run ${run.id.slice(0, 8)}`);
      else if (!isReviewerAgentRole(context.role))
        kept.set(binding.sessionId, `${context.role} worker of run ${run.id.slice(0, 8)}`);
    }
  }
  return kept;
}

/** The gateway's policy: the sessions its active runs still need a person to resume. */
export async function gatewayNativeRefreshPolicy(
  sessions: NativeSessionInfo[],
): Promise<ReadonlyMap<string, string>> {
  const { getAllRuns } = await import('../../runs/store.js');
  return sessionsNeedingAPerson(getAllRuns(), sessions);
}
