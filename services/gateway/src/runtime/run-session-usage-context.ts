import { getRun } from '../runs/store.js';

import { recordRunSessionUsage } from './agent-session-usage.js';
import { withAgentUsageContext } from './agent-usage-context.js';

/** Shared engine/RPC attribution; nested helper requests retain the owning run. */
export function withRunSessionUsageContext<T>(
  runId: string | undefined,
  role: string,
  operation: () => T,
): T {
  const run = runId ? getRun(runId) : undefined;
  return withAgentUsageContext(
    {
      runId: run?.id ?? null,
      flowType: run?.flowType ?? null,
      role,
      ...(run ? { record: (receipt) => recordRunSessionUsage(run.id, receipt) } : {}),
    },
    operation,
  );
}
