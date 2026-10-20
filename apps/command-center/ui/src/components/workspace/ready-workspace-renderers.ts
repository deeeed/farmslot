import type { GateDecisionFields, ReadyGatePayload } from '@farmslot/protocol';

import { readyReviewBlockingDisplayReason } from '../../utils/review-gate-display.js';

export { readyWorkspaceLightStyles } from './ready-workspace-styles.js';

export function readyReviewBlockingReason(
  payload: ReadyGatePayload,
  actions?: GateDecisionFields['actions'],
): string {
  return readyReviewBlockingDisplayReason(payload, actions);
}
