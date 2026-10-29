import { type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';

import { buildClaudeSessionDiscoveryCommand } from './claude-observability.js';
import { verifiedRunnerSessionArchivePath } from './session-archive.js';
import { runnerSessionIdForPath } from './session-path-resolution.js';
import { type RecoveredUsageSession, workerUsageScope } from './session-usage-provider.js';

/** Reused worker contexts can replace their session identity during a fix round. */
export async function recoverClaudeUsageSessions(run: Run): Promise<RecoveredUsageSession[]> {
  if (!run.slotId) return [];
  const scope = workerUsageScope(run, 'claude');
  const sessions = new Map<string, RecoveredUsageSession>();
  const add = (contextId: string, runnerSessionPath?: string | null) => {
    if (runnerSessionPath)
      sessions.set(runnerSessionPath, {
        contextId,
        runnerSessionPath,
        runnerSessionId: runnerSessionIdForPath(runnerSessionPath),
      });
  };
  add(scope.primaryRole, run.metrics.runnerSessionPath);
  add(scope.primaryRole, run.metrics.runnerSessionArchive?.originalPath);
  for (const { context } of scope.contexts) {
    add(context.id, context.runnerSessionPath);
    add(context.id, context.runnerSessionArchive?.originalPath);
  }
  const vars = await loadSlotVars(run.slotId);
  for (const { context, startedAt, endedAt, taskDir } of scope.contexts) {
    if (!Number.isFinite(startedAt) || !taskDir) continue;
    const result = await execOnSlot(
      vars,
      buildClaudeSessionDiscoveryCommand(vars.remoteRepo, undefined, {
        taskDir,
        startedAt,
        endedAt,
        reviewerIntervals: scope.reviewerIntervals,
      }),
      { timeout: 10_000, selectNodeSupport: false },
    );
    if (result.exitCode !== 0) throw new Error('Claude usage session recovery failed');
    const paths: string[] = JSON.parse(result.stdout);
    for (const file of paths) add(context.id, file);
  }
  return [...sessions.values()];
}

/** Recount only an archive belonging to the exact recovered worker session. */
export async function recoverClaudeUsageArchive(
  run: Run,
  session: RecoveredUsageSession,
): Promise<string | null> {
  const context = run.agentContexts?.find(
    (context) =>
      context.id === session.contextId &&
      context.runnerSessionArchive?.originalPath === session.runnerSessionPath,
  );
  return context ? verifiedRunnerSessionArchivePath(run, context.id) : null;
}
