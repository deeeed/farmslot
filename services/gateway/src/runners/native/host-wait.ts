import { isNativeHostUnavailableError } from '@farmslot/agent-runtime/native/host-unavailable';
import { Methods } from '@farmslot/protocol';

import { routeNativeExecution } from './node.js';

/** A restarting host is back within seconds; this is the ceiling, not the expectation. */
export const NATIVE_HOST_WAIT_MS = 120_000;
const NATIVE_HOST_PROBE_INTERVAL_MS = 1_000;

function describe(waitedMs: number, budgetMs: number): string {
  return budgetMs <= 0
    ? 'the step had no budget left to wait for it'
    : `waited ${Math.round(waitedMs / 1000)} s of ${Math.round(budgetMs / 1000)} s for it to come back`;
}

/**
 * Wait for a native host that is restarting, for callers that have sent nothing.
 *
 * A node deploy or a cleanup recovery takes the host away for seconds while the
 * next one starts, and a launch that refuses in that window fails a step for a
 * condition that resolves itself. The probe is the passive session list: it reads
 * an existing host and never starts one, so waiting here cannot create a session.
 * The caller sends its one request after this resolves.
 *
 * The wait is bounded by the smaller of its own ceiling and the budget the caller
 * has left, and it ends early when `assertCurrent` says the work it would serve is
 * gone — a cancelled run or a reassigned slot must not hold its slot for the window.
 * Any failure that is not a host that never answered propagates unchanged.
 */
export async function waitForNativeHostReady(input: {
  owner: string;
  executionNodeId: string;
  /** What the caller has left to spend. Defaults to the full ceiling. */
  budgetMs?: number;
  assertCurrent?: () => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ waitedMs: number; probes: number }> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budgetMs = Math.min(NATIVE_HOST_WAIT_MS, input.budgetMs ?? NATIVE_HOST_WAIT_MS);
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let probes = 0;
  for (;;) {
    await input.assertCurrent?.();
    probes += 1;
    try {
      await routeNativeExecution(input.owner, Methods.NATIVE_SESSION_LIST, {
        executionNodeId: input.executionNodeId,
      });
      return { waitedMs: now() - startedAt, probes };
    } catch (error) {
      if (!isNativeHostUnavailableError(error)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) {
        const waited = describe(now() - startedAt, budgetMs);
        throw Object.assign(
          new Error(
            `${(error as Error).message} The host on ${input.executionNodeId} stayed unavailable: ${waited}.`,
            { cause: error },
          ),
          { code: (error as { code?: string }).code },
        );
      }
      await sleep(Math.min(NATIVE_HOST_PROBE_INTERVAL_MS, remaining));
    }
  }
}

export { isNativeHostUnavailableError };
