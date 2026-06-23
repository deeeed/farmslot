import { Methods, type Run, type RunListResult } from '@farmslot/protocol';

import type { GatewayClient } from './gateway-client';

/** Active runs are small enough for mobile cold sync (typically KB–low MB). */
export const ACTIVE_RUN_LIST_LIMIT = 200;
/** Recent history is fetched on demand; cap keeps payloads under mobile WS limits. */
export const HISTORY_RUN_LIST_LIMIT = 80;

export const RUN_LIST_ACTIVE_TIMEOUT_MS = 20_000;
export const RUN_LIST_HISTORY_TIMEOUT_MS = 60_000;

export async function fetchActiveRuns(client: GatewayClient): Promise<Run[]> {
  const result = await client.request<RunListResult>(
    Methods.RUN_LIST,
    { active: true, limit: ACTIVE_RUN_LIST_LIMIT },
    RUN_LIST_ACTIVE_TIMEOUT_MS,
  );
  return result.runs;
}

export async function fetchRecentRunHistory(client: GatewayClient): Promise<Run[]> {
  const result = await client.request<RunListResult>(
    Methods.RUN_LIST,
    { limit: HISTORY_RUN_LIST_LIMIT, sort: 'newest' },
    RUN_LIST_HISTORY_TIMEOUT_MS,
  );
  return result.runs;
}

export function mergeRunsById(existing: Run[], incoming: Run[]): Run[] {
  const byId = new Map(existing.map((run) => [run.id, run]));
  for (const run of incoming) byId.set(run.id, run);
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
