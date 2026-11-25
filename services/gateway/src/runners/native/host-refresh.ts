import { NATIVE_WORKER_ENSURE } from '@farmslot/agent-runtime/native';
import {
  type AgentRole,
  isTerminalRunStatus,
  Methods,
  type NativeSessionInfo,
  type Run,
} from '@farmslot/protocol';

/**
 * Roles whose idle session waits for a person after a refresh: the run's own worker gets the
 * monitor's resume decision, and a CI fix has no automatic resume. A reviewer resumes on its
 * own at its next round, and a review fix through the review loop.
 */
const ROLES_RESUMED_BY_A_PERSON: ReadonlySet<AgentRole> = new Set([
  'primary',
  'dev',
  'fix-bug',
  'ci-fix',
]);

/**
 * Idle sessions on one execution node (the gateway's own by default) a host refresh must not
 * stop, with the reason. A refresh stops idle runners and their next use resumes the saved
 * identity: on their own for warm reviewers, review fixes and worker messages; from the user's
 * own surface for Command Center chat and the Co-Pilot. An active run's static review workspace
 * (operator replay) and its own worker (the monitor's resume decision) would wait for a person
 * instead, so they keep the host.
 */
export function sessionsNeedingAPerson(
  runs: readonly Run[],
  sessions: readonly Pick<NativeSessionInfo, 'id'>[],
  executionNodeId = 'local',
): Map<string, string> {
  const live = new Set(sessions.map((session) => session.id));
  const kept = new Map<string, string>();
  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) continue;
    for (const context of run.agentContexts ?? []) {
      const binding = context.nativeSession;
      if (!binding || !live.has(binding.sessionId)) continue;
      if ((binding.executionNodeId ?? 'local') !== executionNodeId) continue;
      if (run.reviewWorkspaceTarget)
        kept.set(binding.sessionId, `static review workspace of run ${run.id.slice(0, 8)}`);
      else if (ROLES_RESUMED_BY_A_PERSON.has(context.role))
        kept.set(binding.sessionId, `${context.role} worker of run ${run.id.slice(0, 8)}`);
    }
  }
  return kept;
}

/**
 * The owner's sessions bound on an execution node that a launch there may stop to refresh its
 * host: every bound session the keep rule above doesn't keep. The node keeps every session not
 * listed, so unbound sessions (Command Center chat, standalone) and new ones keep its host.
 */
export function nodeReleasedSessions(
  runs: readonly Run[],
  executionNodeId: string,
  owner: string,
): string[] {
  const bound = new Set<string>();
  for (const run of runs)
    for (const context of run.agentContexts ?? []) {
      const binding = context.nativeSession;
      if (binding?.executionNodeId === executionNodeId && binding.ownerPrincipalId === owner)
        bound.add(binding.sessionId);
    }
  const kept = sessionsNeedingAPerson(
    runs,
    [...bound].map((id) => ({ id })),
    executionNodeId,
  );
  return [...bound].filter((id) => !kept.has(id));
}

/**
 * One node launch's release list. An ensure may target a live session it would then find
 * stopped, so its own session is never on it.
 */
export function nodeLaunchRelease(
  runs: readonly Run[],
  executionNodeId: string,
  owner: string,
  method: string,
  params: Record<string, unknown>,
): string[] {
  const target =
    (method === Methods.NATIVE_SESSION_ENSURE || method === NATIVE_WORKER_ENSURE) &&
    typeof params.sessionId === 'string'
      ? params.sessionId
      : undefined;
  return nodeReleasedSessions(runs, executionNodeId, owner).filter((id) => id !== target);
}

/** The gateway's policy: the sessions its active runs still need a person to resume. */
export async function gatewayNativeRefreshPolicy(
  sessions: NativeSessionInfo[],
): Promise<ReadonlyMap<string, string>> {
  // Only a census with live sessions looks at runs; a busy result is reused for a few seconds.
  if (!sessions.length) return new Map();
  const { getAllRuns } = await import('../../runs/store.js');
  return sessionsNeedingAPerson(getAllRuns(), sessions);
}
