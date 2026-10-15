import { NATIVE_WORKER_READ } from '@farmslot/agent-runtime/native';
import type { NativeSessionReadResult } from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import type { ReviewWorkspaceAdmissionInput } from '../../review-workspaces/admission.js';
import { getAllRunsWithArchived } from '../../runs/store.js';

import { routeNativeExecution } from './node.js';

/** Retained startup failures exclude automatic placement until an explicit retry succeeds. */
export async function assertReviewNativeRunnerHealthy(
  input: Pick<
    ReviewWorkspaceAdmissionInput,
    'machine' | 'runner' | 'model' | 'transport' | 'nativeProfile'
  >,
  owner: string,
  executionNodeId: string,
  excludingRunId?: string,
): Promise<void> {
  if (input.transport !== 'native') return;
  const attempts = (await getAllRunsWithArchived())
    .filter(
      (run) =>
        run.id !== excludingRunId &&
        run.flowType === 'review-pr' &&
        run.transport === 'native' &&
        run.nativeOwnerPrincipalId === owner,
    )
    .flatMap((run) =>
      (run.agentContexts ?? [])
        .filter(
          (context) =>
            context.role === 'review' && (context.runner ?? run.metrics.runner) === input.runner,
        )
        .flatMap((context) => (context.nativeSession ? [context.nativeSession] : [])),
    )
    .filter(
      (binding) =>
        binding.ownerPrincipalId === owner &&
        binding.executionNodeId === executionNodeId &&
        binding.launchRequestedAt &&
        binding.profile?.profileId === input.nativeProfile?.profileId &&
        binding.profile?.accountContextId === input.nativeProfile?.accountContextId,
    )
    .sort((a, b) => Date.parse(b.launchRequestedAt!) - Date.parse(a.launchRequestedAt!));
  const latest = attempts[0];
  if (!latest || latest.acceptedAt) return;
  const snapshot = (await routeNativeExecution(owner, NATIVE_WORKER_READ, {
    sessionId: latest.sessionId,
    executionNodeId,
    leaseId: latest.leaseId,
  })) as NativeSessionReadResult;
  const accepted = snapshot.commands.some(
    (command) => command.commandId === latest.commandId && command.accepted,
  );
  if (
    !accepted &&
    (snapshot.session.state === 'failed' ||
      (snapshot.session.state === 'closed' && snapshot.session.error))
  ) {
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      `Native ${input.runner}/${input.model} on ${executionNodeId} failed before accepting a review: ${snapshot.session.error ?? 'Native session failed during startup'}. Select another machine, or verify this runner and explicitly select its machine to retry.`,
    );
  }
}
