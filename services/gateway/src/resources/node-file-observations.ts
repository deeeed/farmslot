import type { WebSocket } from 'ws';

import type { NodeFsChangedPayload, NodeFsWatchResult } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';

interface FileObservation {
  node: ConnectedNode;
  path: string;
  revision: number;
  admitted: boolean;
  failure?: string;
  invalidate(): void;
}
const observations = new Map<string, FileObservation>();

/** Arm the existing producer; unsupported nodes retain their imperative watch behavior. */
export async function watchNodeFile(
  node: ConnectedNode,
  filePath: string,
  onRequestId: (id: string) => void,
  invalidate: () => void,
): Promise<unknown> {
  let source: FileObservation | undefined;
  try {
    const result = (await sendNodeRequest(
      node,
      'fs.watch',
      { path: filePath, observations: 1 },
      {
        requireSameConnection: true,
        onRequestId(id) {
          source = { node, path: filePath, revision: 0, admitted: false, invalidate };
          observations.set(id, source);
          onRequestId(id);
        },
      },
    )) as NodeFsWatchResult;
    if (source) {
      if (getNode(node.machine) !== node || node.observationAuthority?.() === false)
        source.failure = 'The source connection was replaced.';
      else if (
        node.observationCapabilities?.files !== 1 ||
        result.observations !== 1 ||
        !result.initial
      )
        source.failure = 'This node does not support verified file observations.';
      else {
        source.admitted = true;
        // A push received while the ACK was in flight is newer than its initial snapshot.
        if (source.revision === 0)
          source.failure =
            result.initial.kind === 'error' ? result.initial.error.message : undefined;
      }
      source.revision++;
      invalidate();
    }
    return result;
  } catch (error) {
    if (source) {
      source.failure = error instanceof Error ? error.message : String(error);
      source.revision++;
      invalidate();
    }
    throw error;
  }
}

/** Reject former connections, unknown watches and forged paths before any consumer sees an event. */
export function acceptNodeFileObservation(
  ws: WebSocket,
  payload: NodeFsChangedPayload,
): NodeFsChangedPayload | undefined {
  if (payload.kind !== undefined && !['updated', 'deleted', 'error'].includes(payload.kind)) return;
  if (
    typeof payload.content !== 'string' ||
    (payload.kind === 'error' && (!payload.error || typeof payload.error.message !== 'string'))
  )
    return;
  const source = observations.get(payload.requestId);
  if (
    !source ||
    source.node.ws !== ws ||
    getNode(source.node.machine) !== source.node ||
    source.path !== payload.path ||
    source.node.observationAuthority?.() === false
  )
    return;
  source.revision++;
  source.failure = payload.kind === 'error' ? payload.error.message : undefined;
  source.invalidate();
  return { ...payload, machine: source.node.machine };
}

export function forgetNodeFileObservation(requestId: string): void {
  observations.delete(requestId);
}

/** A finite read captures source revisions, so neither a write nor replacement can bless old data. */
export function assertFileObservationsAdmitted(requestIds: readonly string[]): () => void {
  const captured = requestIds.map((id) => {
    const source = observations.get(id);
    if (!source)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNAVAILABLE',
        'The file observation is no longer active.',
      );
    if (!source.admitted)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNSUPPORTED',
        'Verified file observations are unavailable for this read.',
      );
    if (
      getNode(source.node.machine) !== source.node ||
      source.node.observationAuthority?.() === false
    )
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNAVAILABLE',
        'The file producer disconnected or was replaced.',
      );
    if (source.failure) throw new GatewayMethodError('RESOURCE_OBSERVATION_FAILED', source.failure);
    return { id, source, revision: source.revision };
  });
  return () => {
    for (const { id, source, revision } of captured) {
      if (
        observations.get(id) !== source ||
        source.revision !== revision ||
        getNode(source.node.machine) !== source.node ||
        source.node.observationAuthority?.() === false ||
        source.failure
      )
        throw new GatewayMethodError(
          'RESOURCE_OBSERVATION_CHANGED',
          'The file observation changed during this read. Retry against the current producer.',
        );
    }
  };
}

/** Disconnect/replacement revokes every request tied to that producer incarnation. */
export function revokeNodeFileObservations(ws: WebSocket): void {
  for (const [id, source] of observations) {
    if (source.node.ws !== ws) continue;
    observations.delete(id);
    source.invalidate();
  }
}
