import { primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { runnerSessionUsageProviders } from './session-usage-provider.js';

/** Recover missing terminal-workspace identities through the runner's own accounting capability. */
export async function recoverWorkspaceUsageBindings(run: Run): Promise<Run> {
  if (run.transport !== 'tmux' || !run.reviewWorkspace || run.slotId) return run;
  const context = run.agentContexts?.find(
    (entry) => entry.role === primaryRoleForFlow(run.flowType),
  );
  if (!context || context.runnerSessionId || context.nativeSession) return run;
  const sessions = await runnerSessionUsageProviders
    .get(context.runner ?? '')
    ?.recoverSessions?.(run);
  if (run.agentContexts?.find((entry) => entry.id === context.id) !== context) return run;
  const matches = sessions?.filter((session) => session.contextId === context.id) ?? [];
  // Ambiguous transcripts cannot establish which conversation owns this context.
  if (matches.length !== 1) return run;
  return {
    ...run,
    agentContexts: run.agentContexts?.map((entry) =>
      entry.id === context.id
        ? {
            ...entry,
            runnerSessionId: matches[0].runnerSessionId,
            runnerSessionPath: matches[0].runnerSessionPath,
          }
        : entry,
    ),
  };
}
