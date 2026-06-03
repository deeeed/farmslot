import type { ReadyGatePayload } from '@farmslot/protocol';

import { readyReviewBlockingDisplayReason } from '../../utils/review-gate-display.js';

export { readyWorkspaceLightStyles } from './ready-workspace-styles.js';

export function readyReviewBlockingReason(payload: ReadyGatePayload): string {
  return readyReviewBlockingDisplayReason(payload);
}
