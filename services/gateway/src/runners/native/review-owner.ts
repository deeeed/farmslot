import {
  type NativeResultSchema,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type Run,
} from '@farmslot/protocol';

import { isLocal, type loadSlotVars } from '../../core/index.js';
import { getNode } from '../../fleet/machine-registry.js';
import {
  assertNativeRunOwner,
  resolveReviewWorkspaceOwner,
} from '../../security/native-worker-owner.js';
import { runnerNativeResultSchemas } from '../registry.js';

import { offlineAssignedNativeOwner, resolveNativeExecutionNode } from './node.js';

/** Reviewer sessions use their execution owner's profile without changing the producing worker. */
export function nativeReviewerOwner(
  run: Run,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): string {
  if (run.transport === 'native') {
    assertNativeRunOwner(run);
    if (!run.nativeOwnerPrincipalId) throw new Error('Native review has no recorded profile owner');
    return run.nativeOwnerPrincipalId;
  }
  const local = isLocal(vars.host, vars.machine);
  // A gateway reload starts recovery before remote nodes reconnect. The node's issued assignment
  // still names the owner, and resolveNativeExecutionNode reads that offline node as a wait.
  const owner = local
    ? process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID
    : (getNode(vars.machine)?.nativeSessions?.ownerPrincipalId ??
      offlineAssignedNativeOwner(vars.machine));
  if (!owner) throw new Error('The review slot has no native execution owner');
  if (!local) {
    const node = resolveNativeExecutionNode(owner, vars.machine);
    if (!node.nativeSessions.supportsWorkers || !node.nativeSessions.supportsEnsure)
      throw new Error('The review node does not support owned native sessions');
  }
  return resolveReviewWorkspaceOwner(owner);
}

export function nativeReviewerResultSchema(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  schema: NativeResultSchema = PIPELINE_VISUAL_RESULT_SCHEMA,
): NativeResultSchema | undefined {
  if (!runnerNativeResultSchemas(runner).includes(schema)) return undefined;
  if (
    !isLocal(vars.host, vars.machine) &&
    !getNode(vars.machine)?.nativeSessions?.supportsStructuredResults
  )
    return undefined;
  return schema;
}
