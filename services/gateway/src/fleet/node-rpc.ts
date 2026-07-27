// node-rpc.ts — send RPC requests to connected nodes and await responses

import { WebSocket } from 'ws';

import type { ExecResult, NodeExecParams } from '@farmslot/protocol';

import { isLocal, loadSlotVars } from '../core/index.js';

import { type ConnectedNode, getNode } from './machine-registry.js';

let reqSeq = 0;
const pending = new Map<
  string,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }
>();

// Per-request output listeners for streaming exec output
const outputListeners = new Map<string, (stream: string, data: string) => void>();

/**
 * Handle an incoming response frame from a node WebSocket.
 * Call this from the server message handler when frame.type === 'res'.
 */
export function handleNodeResponse(
  id: string,
  ok: boolean,
  payload: unknown,
  errorMsg?: string,
  errorCode?: string,
): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  outputListeners.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  if (ok) {
    entry.resolve(payload);
  } else {
    const error = new Error(errorMsg || 'Node error') as NodeJS.ErrnoException;
    if (errorCode) error.code = errorCode;
    entry.reject(error);
  }
}

/**
 * Route a node.exec.output event to the registered listener for that request.
 */
export function handleNodeExecOutput(requestId: string, stream: string, data: string): void {
  const listener = outputListeners.get(requestId);
  if (listener) listener(stream, data);
}

/**
 * Send an RPC request to a connected node and await the response.
 */
export function sendNodeRequest(
  node: ConnectedNode,
  method: string,
  params: unknown,
  opts?: { timeout?: number; onRequestId?: (id: string) => void },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (node.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Node ${node.machine} WebSocket not open`));
    }
    const id = `gw-${++reqSeq}-${Date.now()}`;
    const TIMEOUT = opts?.timeout ?? 30_000;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Node ${node.machine} timeout after ${TIMEOUT}ms`));
    }, TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    opts?.onRequestId?.(id);
    node.ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

/**
 * Default timeout for streaming RPC calls. Every `sendNodeRequestStreaming`
 * (and therefore every `nodeExec`) gets this guard unless the caller passes a
 * larger explicit value. Without it, a node daemon that connects but never
 * replies causes callers to hang forever — `find-slot`, `prepare`, and every
 * other path that touches a remote slot would stall until the gateway is
 * restarted.
 *
 * Long operations (yarn install, slot prepare, metro start) already pass
 * explicit multi-minute timeouts at the call site; they override this default.
 * This default only ever fires for "slow-forever" bugs, not legitimate work.
 */
const DEFAULT_STREAMING_TIMEOUT_MS = 120_000;

/**
 * Send an RPC request with optional timeout and optional streaming output callback.
 * Used by nodeExec for exec commands that may be long-running.
 */
function sendNodeRequestStreaming(
  node: ConnectedNode,
  method: string,
  params: unknown,
  opts?: { timeout?: number; onOutput?: (stream: string, data: string) => void },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (node.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Node ${node.machine} WebSocket not open`));
    }
    const id = `gw-${++reqSeq}-${Date.now()}`;
    const effectiveTimeout = opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;

    const timer = setTimeout(() => {
      pending.delete(id);
      outputListeners.delete(id);
      const usedDefault = opts?.timeout == null;
      const suffix = usedDefault
        ? ' (default — caller should pass explicit timeout for long ops)'
        : '';
      reject(new Error(`Node ${node.machine} timeout after ${effectiveTimeout}ms${suffix}`));
    }, effectiveTimeout);

    if (opts?.onOutput) {
      outputListeners.set(id, opts.onOutput);
    }

    pending.set(id, { resolve, reject, timer });
    node.ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

/**
 * Wait for a node to (re)connect, polling every second.
 */
async function waitForNode(machine: string, timeoutMs = 15_000): Promise<ConnectedNode> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = getNode(machine);
    if (node && node.ws.readyState === WebSocket.OPEN) return node;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No node connected for machine ${machine} after ${timeoutMs}ms`);
}

export interface NodeExecOpts {
  timeout?: number;
  onOutput?: (stream: string, data: string) => void;
  maxBuffer?: number;
}

/**
 * Run a command on a remote machine via its node's exec handler.
 * Retries once if the node disconnects mid-request (e.g. gateway reload).
 */
export async function nodeExec(
  machine: string,
  cmd: string,
  cwd?: string,
  opts?: NodeExecOpts,
): Promise<ExecResult> {
  return nodeExecRequest(machine, { cmd, cwd }, opts);
}

export async function nodeExecArgv(
  machine: string,
  argv: string[],
  cwd?: string,
  opts?: NodeExecOpts,
): Promise<ExecResult> {
  return nodeExecRequest(machine, { argv, cwd }, opts);
}

async function nodeExecRequest(
  machine: string,
  request: NodeExecParams,
  opts?: NodeExecOpts,
): Promise<ExecResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const node = await waitForNode(machine);
    try {
      return (await sendNodeRequestStreaming(
        node,
        'exec',
        {
          ...request,
          ...(opts?.timeout != null ? { timeout: opts.timeout } : {}),
          ...(opts?.maxBuffer != null ? { maxBuffer: opts.maxBuffer } : {}),
        },
        { timeout: opts?.timeout, onOutput: opts?.onOutput },
      )) as ExecResult;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === 0 && (msg.includes('not open') || msg.includes('timeout'))) {
        console.log(`[node-rpc] exec retry for ${machine}: ${msg}`);
        await new Promise((r) => setTimeout(r, 3000)); // wait for reconnect
        continue;
      }
      throw err;
    }
  }
  throw new Error(`nodeExec failed after retries for ${machine}`);
}

/**
 * Determine if a slot is local and return its SSH coordinates.
 * Computes locality from the pool config (host + machine vs os.hostname()),
 * NOT from the cached fleet status field — that field can lag behind reality
 * and would otherwise force local slots through SSH.
 * Throws if slot not found.
 */
export async function getSlotLocality(slotId: string): Promise<{
  isLocal: boolean;
  machine: string;
  sshTarget?: string;
}> {
  const vars = await loadSlotVars(slotId);
  const local = isLocal(vars.host, vars.machine);
  return {
    isLocal: local,
    machine: vars.machine,
    ...(local ? {} : { sshTarget: vars.sshTarget }),
  };
}
