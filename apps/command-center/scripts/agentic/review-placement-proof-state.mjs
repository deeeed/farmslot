import { ACTIVE_RUN_STATUSES } from '@farmslot/protocol';

export function isRunningReview(run) {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}
