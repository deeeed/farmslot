import type { PeerVersionDeclaration } from '../peer-versions.js';
import type { NodeLinkCapabilities } from '../transport/node-link.js';

export interface NodeInfo extends PeerVersionDeclaration {
  machine: string;
  pid: number;
  nodeLink?: NodeLinkCapabilities;
  connectedAt: string;
  version?: string;
  versionMatch?: boolean;
  compatibilityReason?: string;
  uptime?: number;
  /** This node can cancel exec requests on their original connection. */
  execCancellation?: boolean;
  /** This node supports version 1 of hosted task initialization and receipt verification. */
  taskRuntime?: 1;
  /** This node checks `expectedHash` on file writes, renames and deletes. */
  conditionalWrites?: boolean;
  /** This node types a `tmux.send` carrying `seq` once per (pane, stream, n). */
  terminalInputSequence?: boolean;
}

export interface NodesListResult {
  nodes: NodeInfo[];
  gatewayProtocolVersion: string;
  gatewayCompatibility?: PeerVersionDeclaration;
}

export interface NodeRegistrationResult extends PeerVersionDeclaration {
  registered: boolean;
  nodeLink?: NodeLinkCapabilities;
}

export interface NodeDeployParams {
  machine: string;
}

export interface NodeDeployResult {
  machine: string;
  success: boolean;
  output: string;
}

/** Bounded time for a scoped command to finish its authored teardown. */
export const NODE_EXEC_CLOSEOUT_MS = 5_000;

interface NodeExecCommonParams {
  /** Cancel this execution when its gateway connection closes. */
  requestScoped?: boolean;
  /** Time allowed for signal handlers and teardown before forced termination. */
  closeoutTimeoutMs?: number;
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  /** Policy-selected exports; values never cross the control link. */
  environment?: 'service' | 'login';
}

export type NodeExecParams =
  | (NodeExecCommonParams & { cmd: string; argv?: never })
  | (NodeExecCommonParams & { argv: string[]; cmd?: never });

/** Subscribe for the execution lifetime, including cancellation before subscription. */
export function observeNodeExecAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (signal?.aborted) {
    onAbort();
    return () => {};
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  return () => signal?.removeEventListener('abort', onAbort);
}

/** Share one termination deadline across cancellation, timeout and output-limit failures. */
export function createNodeExecCloseout(
  signalProcess: (signal: 'SIGTERM' | 'SIGKILL') => void,
  timeoutMs = NODE_EXEC_CLOSEOUT_MS,
  onForced?: () => void,
): { terminate(): void; dispose(): void } {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    terminate() {
      if (stopping) return;
      stopping = true;
      signalProcess('SIGTERM');
      timer = setTimeout(() => {
        onForced?.();
        signalProcess('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
