import type { Run } from '@farmslot/protocol';

import { assertNativeRunOwner } from '../../security/native-worker-owner.js';

import { readNativeWorkerSnapshot } from './worker-control.js';

/** Native runtime state lives in the host. Process death does not finish the task. */
export async function reconcileNativeRunAgentRuntime(run: Run): Promise<void> {
  assertNativeRunOwner(run);
  for (const context of run.agentContexts ?? []) {
    const binding = context.nativeSession;
    // Dispatch and resume own their durable in-flight intents. Subtasks share
    // their direct owner's binding and must not be reconciled twice.
    if (!binding?.generation || binding.releasedAt || binding.recovery) continue;
    const snapshot = await readNativeWorkerSnapshot(run.id, undefined, context.id);
    if (context.runnerSessionId && context.runnerSessionId !== snapshot.session.nativeSessionId)
      throw new Error('Native runtime recovery found a different saved conversation');
    // Preserve role status, attempt boundaries and signal identity. The workflow
    // reconciles its receipt and terminal artifact, including for a stopped process.
  }
}
