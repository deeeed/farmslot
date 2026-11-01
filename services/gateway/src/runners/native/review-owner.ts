import { setTimeout as delay } from 'node:timers/promises';

import {
  type NativeResultSchema,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type Run,
} from '@farmslot/protocol';

import { isLocal, type loadSlotVars } from '../../core/index.js';
import { getNode } from '../../fleet/machine-registry.js';
import {
  isNodeTransportUnavailableError,
  NodeTransportUnavailableError,
} from '../../fleet/node-rpc.js';
import {
  assertNativeRunOwner,
  resolveReviewWorkspaceOwner,
} from '../../security/native-worker-owner.js';
import { runnerNativeResultSchemas } from '../registry.js';

import { resolveNativeExecutionNode } from './node.js';

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
  const registered = local ? undefined : getNode(vars.machine);
  // A gateway reload starts recovery before remote nodes reconnect: a node not yet back is a
  // wait, not a missing owner.
  if (!local && !registered)
    throw new NodeTransportUnavailableError(
      vars.machine,
      'not-connected',
      'Native execution node is temporarily unavailable',
    );
  const owner = local
    ? process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID
    : registered?.nativeSessions?.ownerPrincipalId;
  if (!owner) throw new Error('The review slot has no native execution owner');
  if (!local) {
    const node = resolveNativeExecutionNode(owner, vars.machine);
    if (!node.nativeSessions.supportsWorkers || !node.nativeSessions.supportsEnsure)
      throw new Error('The review node does not support owned native sessions');
  }
  return resolveReviewWorkspaceOwner(owner);
}

/** Wait out a node that has not reconnected yet; every other refusal stays immediate. */
export async function waitForNativeReviewerOwner(
  run: Run,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  options: {
    /** Throws when the review was superseded while it waited. */
    check?: () => void;
    timeoutMs?: number;
    intervalMs?: number;
    resolve?: typeof nativeReviewerOwner;
  } = {},
): Promise<string> {
  const resolve = options.resolve ?? nativeReviewerOwner;
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    try {
      return resolve(run, vars);
    } catch (error) {
      if (!isNodeTransportUnavailableError(error) || Date.now() >= deadline) throw error;
    }
    await delay(options.intervalMs ?? 1_000);
    options.check?.();
  }
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
