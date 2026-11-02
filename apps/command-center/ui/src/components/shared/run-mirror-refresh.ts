import { Methods, type RunRefreshMirrorResult } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { transferBoundRequestOptions } from '../../gateway-request-timeout.js';

/**
 * Copies a run's evidence from its slot into the gateway artifact mirror again. The request
 * stays open while the copy reports progress: a large changed package outlasts any fixed window.
 */
export function refreshRunMirror(runId: string): Promise<RunRefreshMirrorResult> {
  return gateway.request<RunRefreshMirrorResult>(
    Methods.RUN_REFRESH_MIRROR,
    { runId },
    transferBoundRequestOptions(runId),
  );
}
