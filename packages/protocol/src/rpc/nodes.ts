export interface NodeInfo {
  machine: string;
  pid: number;
  connectedAt: string;
  version?: string;
  protocolVersion?: string;
  versionMatch?: boolean;
  uptime?: number;
  /** This node can cancel exec requests on their original connection. */
  execCancellation?: boolean;
  /** This node checks `expectedHash` on file writes, renames and deletes. */
  conditionalWrites?: boolean;
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
