import type { WebSocket } from 'ws';

import type { NativeExecutionNodeDeclaration, NodeInfo } from '@farmslot/protocol';

export interface ConnectedNode {
  machine: string;
  pid: number;
  connectedAt: string;
  protocolVersion?: string;
  versionMatch?: boolean;
  ws: WebSocket;
  nativeSessions?: NativeExecutionNodeDeclaration;
  nativeAuthority?: { principalId: string; valid(): boolean };
  /** URL the node itself dials to reach this gateway (its GATEWAY_URL). */
  gatewayUrl?: string;
}

const nodes = new Map<string, ConnectedNode>();

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
): void {
  const versionMatch = protocolVersion != null && protocolVersion === gatewayProtocolVersion;
  nodes.set(machine, {
    machine,
    pid,
    connectedAt: new Date().toISOString(),
    protocolVersion,
    versionMatch: protocolVersion != null ? versionMatch : undefined,
    ws,
    nativeSessions,
    nativeAuthority,
    gatewayUrl: workerGatewayUrl(gatewayUrl),
  });
}

export function unregisterByWs(ws: WebSocket): string | null {
  for (const [machine, node] of nodes) {
    if (node.ws === ws) {
      nodes.delete(machine);
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
    connectedAt: node.connectedAt,
    protocolVersion: node.protocolVersion,
    versionMatch: node.versionMatch,
    uptime: (Date.now() - new Date(node.connectedAt).getTime()) / 1000,
  }));
}
