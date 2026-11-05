import { primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { type RecoveredUsageSession, workerUsageScope } from './session-usage-provider.js';

/** Recorded identities only. A worker and its retained fixes may share one conversation. */
export async function recoverCodexUsageSessions(run: Run): Promise<RecoveredUsageSession[]> {
  const sessions = new Map<string, RecoveredUsageSession>();
  const primary = primaryRoleForFlow(run.flowType);
  const add = (contextId: string, id?: string | null, file?: string | null) => {
    if (id && file) sessions.set(id, { contextId, runnerSessionId: id, runnerSessionPath: file });
  };
  add(primary, run.metrics.runnerSessionId, run.metrics.runnerSessionPath);
  for (const { context } of workerUsageScope(run, 'codex').contexts)
    add(context.id, context.runnerSessionId, context.runnerSessionPath);
  const roles = new Set([primary, 'primary', 'worker', 'review-fix', 'ci-fix']);
  for (const row of run.sessionUsage ?? []) {
    if (
      row.runner !== 'codex' ||
      row.kind === 'helper' ||
      ![row.role, ...(row.roles ?? [])].some((role) => role && roles.has(role))
    )
      continue;
    if (row.runnerSessionId && !sessions.has(row.runnerSessionId))
      add(row.contextIds?.[0] ?? primary, row.runnerSessionId, row.runnerSessionPath);
  }
  return [...sessions.values()];
}
