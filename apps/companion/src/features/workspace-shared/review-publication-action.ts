import {
  Methods,
  type PRReviewPublishResult,
  type Run,
  type RunGetResult,
} from '@farmslot/protocol';

import type { GatewayClient } from '../../lib/gateway-client';

/** Recheck authority after each reply before adopting data into the current farm. */
export async function retryReviewPublication(
  client: Pick<GatewayClient, 'request'>,
  runId: string,
  isCurrent: () => boolean,
  accept: (run: Run) => void,
) {
  if (!isCurrent()) return;
  await client.request<PRReviewPublishResult>(Methods.PR_REVIEW_PUBLISH, { runId }, 120_000);
  if (!isCurrent()) return;
  const result = await client.request<RunGetResult>(Methods.RUN_GET, { runId });
  if (isCurrent()) accept(result.run);
}
