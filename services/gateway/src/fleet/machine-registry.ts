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
import type { NodeFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { setNodeFarmPathsLookup } from '@farmslot/slot-config';

import { revokeNodeFileObservations } from '../resources/node-file-observations.js';
import { resourceRevisions } from '../resources/revisions.js';
import { publishWorkerResources, scheduleWorkerStatusExpiry } from '../resources/worker-changes.js';
import { advanceSourceRevision } from '../sources/change-signal.js';

import { gatewayPeerVersions } from './peer-versions.js';

export interface ConnectedNode extends PeerVersionDeclaration {
  machine: string;
  farmPaths?: NodeFarmPaths;
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
  /** The last connection refused because this node already held the machine. */
  lastRefusedDuplicate?: { pid: number; at: string };
  lastRefusalWarnAt?: number;
}

const nodes = new Map<string, ConnectedNode>();
setNodeFarmPathsLookup((machine) => nodes.get(machine)?.farmPaths);
const nodeConnectListeners = new Set<() => void>();
/** Machines with a node.connect admission probe in progress. */
const admissions = new Set<string>();
/** When each node socket last sent the gateway a frame: a busy node is alive even if a probe is slow. */
const lastFrameAt = new WeakMap<WebSocket, number>();
const REFUSAL_WARN_INTERVAL_MS = 60_000;
export const NODE_ADMISSION_PROBE_MS = 3_000;

export function noteNodeFrame(ws: WebSocket): void {
  lastFrameAt.set(ws, Date.now());
}

/**
 * How the connected node answered a health check on its own socket: `answered` (any reply,
 * including a node error), `stopping` (NODE_SHUTTING_DOWN), or `silent` (no reply in time).
 */
export type NodeProbeVerdict = 'answered' | 'stopping' | 'silent';

export interface NodeAdmissionDeps {
  probe: (incumbent: ConnectedNode) => Promise<NodeProbeVerdict>;
  /** The connected node already said it is shutting down (node-rpc's stopping set). */
  isStopping: (ws: WebSocket) => boolean;
  budgetMs?: number;
}

export type NodeAdmission =
  | { kind: 'admitted'; release: () => void; terminateAfterRegister?: WebSocket }
  | { kind: 'refused'; code: 'NODE_ALREADY_CONNECTED' | 'NODE_ADMISSION_IN_PROGRESS'; incumbentPid?: number; message: string };

/**
 * One live node per machine. A second process for a connected machine is refused while the
 * connected one still answers, or each would evict the other on every reconnect. The same process
 * reconnecting, a connected node whose socket is closed or that is shutting down, and one that
 * stays silent are replaced as before; only a silent one's socket is closed afterwards. The caller
 * registers the node and then calls `release`.
 */
export async function admitNodeConnection(
  machine: string,
  pid: number,
  ws: WebSocket,
  deps: NodeAdmissionDeps,
): Promise<NodeAdmission> {
  const none = () => undefined;
  const existing = nodes.get(machine);
  if (
    !existing ||
    existing.ws === ws ||
    existing.pid === pid ||
    existing.ws.readyState !== existing.ws.OPEN ||
    deps.isStopping(existing.ws)
  )
    return { kind: 'admitted', release: none };
  if (admissions.has(machine))
    return {
      kind: 'refused',
      code: 'NODE_ADMISSION_IN_PROGRESS',
      message: `Another connection for node ${machine} is being admitted; refused pid ${pid}`,
    };
  admissions.add(machine);
  const release = () => void admissions.delete(machine);
  try {
    const budgetMs = deps.budgetMs ?? NODE_ADMISSION_PROBE_MS;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let verdict = await Promise.race([
      deps.probe(existing).catch((): NodeProbeVerdict => 'silent'),
      new Promise<NodeProbeVerdict>((resolve) => {
        timer = setTimeout(() => resolve('silent'), budgetMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // A reply already received but not yet read must not lose to the timer.
    await new Promise((resolve) => setImmediate(resolve));
    if (deps.isStopping(existing.ws)) verdict = 'stopping';
    else if (verdict === 'silent' && (lastFrameAt.get(existing.ws) ?? 0) >= started) verdict = 'answered';
    if (nodes.get(machine) !== existing) {
      release();
      return {
        kind: 'refused',
        code: 'NODE_ADMISSION_IN_PROGRESS',
        message: `Node ${machine} changed while pid ${pid} was being admitted; retry`,
      };
    }
    if (verdict === 'answered') {
      release();
      const now = Date.now();
      existing.lastRefusedDuplicate = { pid, at: new Date(now).toISOString() };
      if (now - (existing.lastRefusalWarnAt ?? 0) >= REFUSAL_WARN_INTERVAL_MS) {
        existing.lastRefusalWarnAt = now;
        console.warn(
          `[node] refused a second connection for ${machine}: pid ${pid} while pid ${existing.pid} is connected and answering`,
        );
        resourceRevisions.advance({ family: 'node', scope: 'farm' });
        resourceRevisions.advance({ family: 'node', nodeId: machine });
      }
      return {
        kind: 'refused',
        code: 'NODE_ALREADY_CONNECTED',
        incumbentPid: existing.pid,
        message: `Node ${machine} is already connected (pid ${existing.pid}); refused pid ${pid}`,
      };
    }
    console.warn(`[node] replacing node ${machine} pid ${existing.pid} (${verdict}) with pid ${pid}`);
    return {
      kind: 'admitted',
      release,
      ...(verdict === 'silent' ? { terminateAfterRegister: existing.ws } : {}),
    };
  } catch (error) {
    release();
    throw error;
  }
}

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
    farmPaths?: NodeFarmPaths;
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
    ...(versions?.farmPaths ? { farmPaths: versions.farmPaths } : {}),
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
    ...(node.farmPaths ? { farmPaths: node.farmPaths } : {}),
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
    ...(node.observationCapabilities
      ? { observationCapabilities: { ...node.observationCapabilities } }
      : {}),
    ...(node.lastRefusedDuplicate ? { lastRefusedDuplicate: { ...node.lastRefusedDuplicate } } : {}),
    uptime: (Date.now() - new Date(node.connectedAt).getTime()) / 1000,
  }));
}
