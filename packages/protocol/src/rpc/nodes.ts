export interface NodeInfo {
  machine: string;
  pid: number;
  connectedAt: string;
  version?: string;
  protocolVersion?: string;
  versionMatch?: boolean;
  uptime?: number;
}

export interface NodesListResult {
  nodes: NodeInfo[];
  gatewayProtocolVersion: string;
}

export interface NodeDeployParams {
  machine: string;
}

export interface NodeDeployResult {
  machine: string;
  success: boolean;
  output: string;
}

interface NodeExecCommonParams {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}

export type NodeExecParams =
  | (NodeExecCommonParams & { cmd: string; argv?: never })
  | (NodeExecCommonParams & { argv: string[]; cmd?: never });
