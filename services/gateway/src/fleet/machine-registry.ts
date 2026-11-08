import type { WebSocket } from 'ws';

import {
  type NativeExecutionNodeDeclaration,
  type NodeInfo,
  type NodeLinkCapabilities,
  type NodeLinkPrincipal,
  type NodeObservationCapabilities,
  peerVersionCompatibility,
  type PeerVersionDeclaration,
} from '@farmslot/protocol';

import { revokeNodeFileObservations } from '../resources/node-file-observations.js';
import { resourceRevisions } from '../resources/revisions.js';
import { publishWorkerResources, scheduleWorkerStatusExpiry } from '../resources/worker-changes.js';
import { advanceSourceRevision } from '../sources/change-signal.js';

import { gatewayPeerVersions } from './peer-versions.js';

export interface ConnectedNode extends PeerVersionDeclaration {
  machine: string;
  pid: number;
  nodeLink?: NodeLinkCapabilities;
  nodePrincipal?: NodeLinkPrincipal;
  connectedAt: string;
  versionMatch?: boolean;
  compatibilityReason?: string;
  ws: WebSocket;
  nativeSessions?: NativeExecutionNodeDeclaration;
  nativeAuthority?: { principalId: string; valid(): boolean };
  /** URL the node itself dials to reach this gateway (its GATEWAY_URL). */
  gatewayUrl?: string;
  execCancellation?: boolean;
  taskRuntime?: 1;
  /** The node checks `expectedHash` on file writes (ADR-009 Amendment 1). */
  conditionalWrites?: boolean;
  /** The node types a `tmux.send` carrying `seq` once per (pane, stream, n). */
  terminalInputSequence?: boolean;
  observationCapabilities?: NodeObservationCapabilities;
  observationAuthority?: () => boolean;
}

const nodes = new Map<string, ConnectedNode>();
const nodeConnectListeners = new Set<() => void>();

export function onNodeConnected(listener: () => void): () => void {
  nodeConnectListeners.add(listener);
  return () => {
    nodeConnectListeners.delete(listener);
  };
}

/** Exported into every worker shell, so keep only a ws(s) URL with no embedded credentials. */
function workerGatewayUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

export function registerNode(
  machine: string,
  pid: number,
  ws: WebSocket,
  protocolVersion?: string,
  gatewayProtocolVersion?: string,
  nativeSessions?: NativeExecutionNodeDeclaration,
  nativeAuthority?: ConnectedNode['nativeAuthority'],
  gatewayUrl?: string,
  execCancellation?: boolean,
  observationCapabilities?: NodeObservationCapabilities,
  observationAuthority?: () => boolean,
  conditionalWrites?: boolean,
  terminalInputSequence?: boolean,
  versions?: {
    node: PeerVersionDeclaration;
    gateway?: PeerVersionDeclaration;
    nodeLink?: NodeLinkCapabilities;
    nodePrincipal?: NodeLinkPrincipal;
    taskRuntime?: 1;
  },
): void {
  const declaration = { ...versions?.node, protocolVersion };
  const compatibility = peerVersionCompatibility(
    { ...(versions?.gateway ?? gatewayPeerVersions), protocolVersion: gatewayProtocolVersion },
    declaration,
    'gateway',
    `node ${machine}`,
  );
  const previous = nodes.get(machine);
  if (previous) revokeNodeFileObservations(previous.ws);
  nodes.set(machine, {
    machine,
    pid,
    ...(versions?.nodeLink ? { nodeLink: versions.nodeLink } : {}),
    ...(versions?.nodePrincipal ? { nodePrincipal: versions.nodePrincipal } : {}),
    ...(versions?.taskRuntime === 1 ? { taskRuntime: 1 } : {}),
    connectedAt: new Date().toISOString(),
    ...declaration,
    versionMatch: compatibility.compatible,
    compatibilityReason: compatibility.reason,
    ws,
    nativeSessions,
    observationCapabilities,
    observationAuthority,
    nativeAuthority,
    gatewayUrl: workerGatewayUrl(gatewayUrl),
    ...(execCancellation ? { execCancellation: true } : {}),
    ...(conditionalWrites ? { conditionalWrites: true } : {}),
    ...(terminalInputSequence ? { terminalInputSequence: true } : {}),
  });
  // Source status reads node receipts live; a reconnect changes what it can report.
  advanceSourceRevision();
  scheduleWorkerStatusExpiry(machine, []);
  publishWorkerResources(machine);
  resourceRevisions.advance({ family: 'node', scope: 'farm' });
  resourceRevisions.advance({ family: 'node', nodeId: machine });
  for (const listener of nodeConnectListeners) listener();
}

export function unregisterByWs(ws: WebSocket): string | null {
  for (const [machine, node] of nodes) {
    if (node.ws === ws) {
      nodes.delete(machine);
      advanceSourceRevision();
      scheduleWorkerStatusExpiry(machine, []);
      publishWorkerResources(machine);
      resourceRevisions.advance({ family: 'node', scope: 'farm' });
      resourceRevisions.advance({ family: 'node', nodeId: machine });
      return machine;
    }
  }
  return null;
}

export function getNode(machine: string): ConnectedNode | undefined {
  return nodes.get(machine);
}

export function getAllNodes(): NodeInfo[] {
  return Array.from(nodes.values()).map((node) => ({
    machine: node.machine,
    pid: node.pid,
    ...(node.nodeLink ? { nodeLink: node.nodeLink } : {}),
    connectedAt: node.connectedAt,
    protocolVersion: node.protocolVersion,
    minimumProtocolVersion: node.minimumProtocolVersion,
    runtimeVersion: node.runtimeVersion,
    minimumRuntimeVersion: node.minimumRuntimeVersion,
    versionMatch: node.versionMatch,
    compatibilityReason: node.compatibilityReason,
    ...(node.execCancellation ? { execCancellation: true } : {}),
    ...(node.taskRuntime === 1 ? { taskRuntime: 1 } : {}),
    ...(node.conditionalWrites ? { conditionalWrites: true } : {}),
    ...(node.terminalInputSequence ? { terminalInputSequence: true } : {}),
    uptime: (Date.now() - new Date(node.connectedAt).getTime()) / 1000,
  }));
}
