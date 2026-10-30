import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getResourceCache } from '../../resource-cache.js';
import { decisionsQuery } from '../../state.js';
import { readCurrent } from '../shared/read-current.js';

export async function assertInboxDecisionReady(
  decisionId: string,
  actionId?: string,
): Promise<void> {
  const cache = getResourceCache();
  // Run writes reread the inbox at most every 30 s; an answer reads it first.
  if (cache && gateway.connectionState === 'connected') await readCurrent(cache, [decisionsQuery]);
  const state = getResourceCache()?.read(decisionsQuery);
  const decision = state?.data?.decisions.find(({ id }) => id === decisionId);
  if (gateway.connectionState !== 'connected' || state?.status !== 'ready' || !decision)
    throw new Error('Wait for current decisions before acting.');
  if (actionId && !decision.actions.some(({ id }) => id === actionId))
    throw new Error('The decision changed. Review its current actions before retrying.');
}

export async function resolveInboxDecision(decisionId: string, actionId: string): Promise<void> {
  await assertInboxDecisionReady(decisionId, actionId);
  await gateway.request(Methods.DECISION_RESOLVE, { decisionId, actionId });
  // Run writes reread the list at most every 30 s; the user's own answer is read at once, by a
  // read that starts after it.
  const cache = getResourceCache();
  void (cache?.retryAfterPending?.(decisionsQuery) ?? cache?.retry(decisionsQuery))?.catch(
    () => undefined,
  );
}
