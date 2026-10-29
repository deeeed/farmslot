import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getResourceCache } from '../../resource-cache.js';
import { decisionsQuery } from '../../state.js';

export function assertInboxDecisionReady(decisionId: string, actionId?: string): void {
  const state = getResourceCache()?.read(decisionsQuery);
  const decision = state?.data?.decisions.find(({ id }) => id === decisionId);
  if (gateway.connectionState !== 'connected' || state?.status !== 'ready' || !decision)
    throw new Error('Wait for current decisions before acting.');
  if (actionId && !decision.actions.some(({ id }) => id === actionId))
    throw new Error('The decision changed. Review its current actions before retrying.');
}

export async function resolveInboxDecision(decisionId: string, actionId: string): Promise<void> {
  assertInboxDecisionReady(decisionId, actionId);
  await gateway.request(Methods.DECISION_RESOLVE, { decisionId, actionId });
  // Run writes reread the list at most every 30 s; the user's own answer is read at once.
  void getResourceCache()?.retry(decisionsQuery);
}
