import type { WebSocket } from 'ws';

import type { NodeFsWorkspaceChangedPayload } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';

interface Interest {
  node: ConnectedNode;
  root: string;
  changed(): void;
  failed(error: Error): void;
  ownerId?: string;
}
const interests = new Map<string, Interest>();
/** Separate cohort on the existing fs.watch RPC. A file-only ACK cannot admit a workspace. */
export async function armNodeWorkspace(
  node: ConnectedNode,
  root: string,
  changed: () => void,
  failed: (error: Error) => void,
  ownerId?: string,
): Promise<() => void> {
  if (node.observationCapabilities?.workspace !== 1)
    throw new GatewayMethodError(
      'RESOURCE_OBSERVATION_UNSUPPORTED',
      'Node does not advertise recursive workspace observation',
    );
  let id: string | undefined;
  let stopped = false;
  const authorityCurrent = () =>
    getNode(node.machine) === node &&
    node.observationAuthority?.() !== false &&
    (!ownerId ||
      (node.nativeSessions?.ownerPrincipalId === ownerId &&
        node.nativeAuthority?.valid() === true));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    node.ws.off('close', closed);
    if (!id) return;
    interests.delete(id);
    if (getNode(node.machine) === node && node.ws.readyState === 1)
      void sendNodeRequest(
        node,
        'fs.watch.stop',
        { requestId: id },
        { requireSameConnection: true },
      ).catch((error) => failed(error instanceof Error ? error : new Error(String(error))));
  };
  node.ws.once('close', closed);
  try {
    const ack = (await sendNodeRequest(
      node,
      'fs.watch',
      { path: root, workspace: 1 },
      {
        requireSameConnection: true,
        onRequestId(requestId) {
          id = requestId;
          interests.set(requestId, { node, root, changed, failed, ownerId });
        },
      },
    )) as { workspace?: number; ready?: boolean };
    if (ack.workspace !== 1 || !ack.ready)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNSUPPORTED',
        'Node cannot observe workspace names, bytes and git metadata',
      );
    if (stopped || !authorityCurrent()) throw new Error('Workspace source connection replaced');
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
  function closed() {
    stop();
    failed(new Error('Workspace source disconnected'));
  }
}
export function acceptWorkspaceSourceEvent(ws: WebSocket, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Reflect.get(value, 'workspace') !== 1) return false;
  const event = value as NodeFsWorkspaceChangedPayload;
  const interest = interests.get(event.requestId);
  if (
    !interest ||
    interest.node.ws !== ws ||
    event.path !== interest.root ||
    event.machine !== interest.node.machine
  )
    return true;
  if (
    getNode(interest.node.machine) !== interest.node ||
    interest.node.observationAuthority?.() === false ||
    (interest.ownerId !== undefined &&
      (interest.node.nativeSessions?.ownerPrincipalId !== interest.ownerId ||
        interest.node.nativeAuthority?.valid() !== true))
  ) {
    interests.delete(event.requestId);
    interest.failed(new Error('Workspace source authority changed'));
    return true;
  }
  if (event.kind === 'updated') interest.changed();
  else if (event.kind === 'error' && typeof event.error?.message === 'string')
    interest.failed(new Error(event.error.message));
  else interest.failed(new Error('Malformed workspace source event'));
  return true;
}
