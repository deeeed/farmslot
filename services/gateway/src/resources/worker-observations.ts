import type { WebSocket } from 'ws';

import type { NodeTmuxPane, NodeTmuxWorkerObservation } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { type ConnectedNode, getAllNodes, getNode } from '../fleet/machine-registry.js';

import { publishWorkerResources, scheduleWorkerStatusExpiry } from './worker-changes.js';

type WorkerSource = NodeTmuxWorkerObservation & { revision: number };
const sources = new WeakMap<ConnectedNode, WorkerSource>();

/** Payload machine names never select an owner. Only the current registered socket does. */
export function acceptWorkerObservation(
  ws: WebSocket,
  payload: unknown,
): ConnectedNode | undefined {
  const node = getAllNodes()
    .map(({ machine }) => getNode(machine)!)
    .find((node) => node.ws === ws);
  if (!node || node.observationCapabilities?.workers !== 1 || !node.observationAuthority?.())
    return undefined;
  const source = payload as Partial<NodeTmuxWorkerObservation> | undefined;
  const previous = sources.get(node);
  if (
    !source ||
    !Number.isFinite(source.observedAt) ||
    (previous && source.observedAt! < previous.observedAt)
  )
    return undefined;
  if (source.status !== 'ready' && source.status !== 'unavailable') return undefined;
  if (source.status === 'ready' && !Array.isArray(source.panes)) return undefined;
  if (
    source.status === 'unavailable' &&
    (!source.error ||
      typeof source.error.code !== 'string' ||
      typeof source.error.message !== 'string')
  )
    return undefined;
  const observation = source as NodeTmuxWorkerObservation;
  sources.set(node, { ...observation, revision: (previous?.revision ?? 0) + 1 });
  scheduleWorkerStatusExpiry(node.machine, observation.status === 'ready' ? observation.panes : []);
  publishWorkerResources(node.machine);
  return node;
}

export interface AdmittedWorkerSource {
  node: ConnectedNode;
  revision: number;
  panes: NodeTmuxPane[];
}

export function requireWorkerObservation(nodeId: string): AdmittedWorkerSource {
  const node = getNode(nodeId);
  if (!node || node.ws.readyState !== 1 || !node.observationAuthority?.())
    throw new GatewayMethodError('RESOURCE_SOURCE_UNAVAILABLE', `Node ${nodeId} is disconnected`);
  if (node.observationCapabilities?.workers !== 1)
    throw new GatewayMethodError(
      'RESOURCE_OBSERVATION_UNSUPPORTED',
      `Node ${nodeId} does not support worker observations`,
    );
  const source = sources.get(node);
  if (!source || source.status !== 'ready')
    throw new GatewayMethodError(
      'RESOURCE_SOURCE_UNAVAILABLE',
      source?.status === 'unavailable'
        ? `${nodeId}: ${source.error.message}`
        : `Node ${nodeId} has not published worker observations`,
    );
  return { node, revision: source.revision, panes: source.panes };
}

export function assertWorkerObservationCurrent(source: AdmittedWorkerSource): void {
  if (
    !source.node.observationAuthority?.() ||
    source.node.ws.readyState !== 1 ||
    getNode(source.node.machine) !== source.node ||
    sources.get(source.node)?.revision !== source.revision
  )
    throw new GatewayMethodError(
      'RESOURCE_SOURCE_CHANGED',
      'Worker source changed during the read',
    );
}
