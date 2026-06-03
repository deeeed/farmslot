import type { WebSocket } from 'ws';

export interface ConnectedNode {
  machine: string;
  pid: number;
  connectedAt: string;
  protocolVersion?: string;
  versionMatch?: boolean;
  ws: WebSocket;
}

const nodes = new Map<string, ConnectedNode>();

export function registerNode(
  machine: string,
  pid: number,
  ws: WebSocket,
  protocolVersion?: string,
  gatewayProtocolVersion?: string,
): void {
  const versionMatch = protocolVersion != null && protocolVersion === gatewayProtocolVersion;
  nodes.set(machine, {
    machine,
    pid,
    connectedAt: new Date().toISOString(),
    protocolVersion,
    versionMatch: protocolVersion != null ? versionMatch : undefined,
    ws,
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

export function getAllNodes(): Array<Omit<ConnectedNode, 'ws'> & { uptime: number }> {
  return Array.from(nodes.values()).map(({ ws: _ws, ...rest }) => ({
    ...rest,
    uptime: (Date.now() - new Date(rest.connectedAt).getTime()) / 1000,
  }));
}
