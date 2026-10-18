import { NATIVE_WORKER_RESPOND } from '@farmslot/agent-runtime/native';
import type { NativeSessionReadResult, NativeWorkerSessionBinding } from '@farmslot/protocol';

import { routeNativeExecution } from '../runners/native/node.js';

/**
 * A native reviewer runs read-only and nobody watches its session, so an approval it asks
 * for would wait out the review deadline. Refuse each request at once and let the reviewer
 * carry on from the code. A request whose answer is already in flight is left alone.
 */
export async function refuseReviewerApprovals(
  binding: NativeWorkerSessionBinding,
  snapshot: Pick<NativeSessionReadResult, 'pendingRequests'>,
): Promise<number> {
  const asked = snapshot.pendingRequests.filter(
    (event) => event.type === 'approval.requested' && event.request && !event.responseState,
  );
  for (const event of asked)
    await routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_RESPOND, {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      generation: binding.generation,
      leaseId: binding.leaseId,
      requestId: event.request!.id,
      response: { decision: 'deny' },
    });
  return asked.length;
}
