import type { RunCIWatchPokeResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

export interface CIWatchPokeOutcome {
  ok: boolean;
  woken: boolean;
  message: string;
}

export async function pokeCIWatchNow(runId: string): Promise<CIWatchPokeOutcome> {
  const result = (await gateway.request(Methods.RUN_CI_WATCH_POKE, {
    runId,
  })) as RunCIWatchPokeResult;
  return {
    ok: result.ok,
    woken: result.ok && result.woken,
    message: result.ok
      ? result.woken
        ? 'Woken — polling now'
        : 'No active poll to wake'
      : result.reason,
  };
}
