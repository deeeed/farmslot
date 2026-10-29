// Lifecycle of the gateway-owned PR detail observations: pr.status, pr.forSlot, pr.reviewComments.
import { Methods } from '@farmslot/protocol';

import { prForSlotObservation, prStatusObservation } from '../pr.js';

import { prReviewThreadsObservation } from './review-comments.js';

export type PRDetailObservationMethod =
  | typeof Methods.PR_STATUS
  | typeof Methods.PR_FOR_SLOT
  | typeof Methods.PR_REVIEW_COMMENTS;

/** Start passive collection; `hasInterest` reports managed observers of one normalized query. */
export function startPRDetailObservations(options: {
  hasInterest(method: PRDetailObservationMethod, params: unknown): boolean;
}): () => Promise<void> {
  const stops = [
    prStatusObservation.start({
      hasInterest: (params) => options.hasInterest(Methods.PR_STATUS, params),
    }),
    prForSlotObservation.start({
      hasInterest: (params) => options.hasInterest(Methods.PR_FOR_SLOT, params),
    }),
    prReviewThreadsObservation.start({
      hasInterest: (params) => options.hasInterest(Methods.PR_REVIEW_COMMENTS, params),
    }),
  ];
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}

/** Observer membership changed: collect newly observed, due queries without a second timer. */
export async function wakePRDetailObservations(): Promise<void> {
  await Promise.all([
    prStatusObservation.tick(),
    prForSlotObservation.tick(),
    prReviewThreadsObservation.tick(),
  ]);
}

/** Drop a client's legacy interest, for one adopted method or on disconnect for all of them. */
export function forgetPRDetailClientInterest(
  clientId: string,
  method?: PRDetailObservationMethod,
): void {
  if (method === undefined || method === Methods.PR_STATUS) prStatusObservation.forget(clientId);
  if (method === undefined || method === Methods.PR_FOR_SLOT) prForSlotObservation.forget(clientId);
  if (method === undefined || method === Methods.PR_REVIEW_COMMENTS)
    prReviewThreadsObservation.forget(clientId);
}
