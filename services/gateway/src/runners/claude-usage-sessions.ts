import path from 'node:path';

import { primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';

import { buildClaudeSessionDiscoveryCommand } from './claude-observability.js';
import { runnerSessionIdForPath } from './session-path-resolution.js';
import type { RecoveredUsageSession } from './session-usage-provider.js';

/** Reused worker contexts can replace their session identity during a fix round. */
export async function recoverClaudeUsageSessions(run: Run): Promise<RecoveredUsageSession[]> {
  if (!run.slotId) return [];
  const primary = primaryRoleForFlow(run.flowType);
  const contexts = run.agentContexts ?? [];
  const workers = contexts.filter(
    (context) =>
      context.runner === 'claude' && [primary, 'review-fix', 'ci-fix'].includes(context.role),
  );
  const sessions = new Map<string, RecoveredUsageSession>();
  const add = (contextId: string, runnerSessionPath?: string | null) => {
    if (runnerSessionPath)
      sessions.set(runnerSessionPath, {
        contextId,
        runnerSessionPath,
        runnerSessionId: runnerSessionIdForPath(runnerSessionPath),
      });
  };
  add(primary, run.metrics.runnerSessionPath);
  add(primary, run.metrics.runnerSessionArchive?.originalPath);
  for (const context of workers) {
    add(context.id, context.runnerSessionPath);
    add(context.id, context.runnerSessionArchive?.originalPath);
  }
  const end = Math.min(Date.now(), Date.parse(run.completedAt ?? '') || Infinity);
  const reviewers = contexts.filter((context) => context.role === 'review' && primary !== 'review');
  const reviewerIntervals = reviewers
    .map((context) => ({
      start: Date.parse(context.startedAt ?? ''),
      end: Date.parse(context.completedAt ?? '') || end,
    }))
    .filter((interval) => Number.isFinite(interval.start));
  const vars = await loadSlotVars(run.slotId);
  for (const context of workers) {
    const start = Date.parse(context.startedAt ?? '');
    if (!Number.isFinite(start) || !context.taskFile) continue;
    const result = await execOnSlot(
      vars,
      buildClaudeSessionDiscoveryCommand(vars.remoteRepo, undefined, {
        taskDir: path.posix.dirname(context.taskFile),
        start,
        end: Math.min(end, Date.parse(context.completedAt ?? '') || Infinity),
        reviewerIntervals,
      }),
      { timeout: 10_000, selectNodeSupport: false },
    );
    if (result.exitCode !== 0) throw new Error('Claude usage session recovery failed');
    const paths: string[] = JSON.parse(result.stdout);
    for (const file of paths) add(context.id, file);
  }
  return [...sessions.values()];
}
