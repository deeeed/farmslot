import type { AgentRole, NativeWorkerSessionBinding } from '@farmslot/protocol';

import { upsertAgentContext } from '../../agents/contexts.js';
import { getRun, persistRunNow } from '../../runs/store.js';

/**
 * A pool or project rewrite refused a native launch before ENSURE was sent, so the host never
 * received this reservation. Forget the launch it was prepared for (its digest and the settings
 * saved with it) under the same session and lease: the engine's retry then prepares and records
 * the re-read inputs instead of refusing a stale digest, and nothing pretends a session existed.
 * One write, with the run rechecked inside it: a replay that superseded this attempt keeps its
 * reservation untouched.
 */
export async function forgetUnsentNativeLaunch(input: {
  runId: string;
  role: AgentRole;
  contextId: string;
  binding: Pick<NativeWorkerSessionBinding, 'sessionId' | 'leaseId'>;
  checkRun: () => unknown;
}): Promise<void> {
  const updated = await upsertAgentContext(
    input.runId,
    input.role,
    { id: input.contextId },
    {
      resolvePatch: (latest) => {
        input.checkRun();
        const live = latest?.nativeSession;
        if (
          !live ||
          live.sessionId !== input.binding.sessionId ||
          live.leaseId !== input.binding.leaseId ||
          live.generation ||
          !live.launchDigest
        )
          return null;
        return {
          nativeSession: {
            ...live,
            launchDigest: undefined,
            accountLabel: undefined,
            effort: undefined,
            safetyTier: undefined,
          },
        };
      },
    },
  );
  const run = updated ? getRun(input.runId) : undefined;
  if (run) await persistRunNow(run, 'unsent native launch forgotten');
}
