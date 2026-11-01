// node-rpc.ts — send RPC requests to connected nodes and await responses

import { AsyncLocalStorage } from 'node:async_hooks';

import { WebSocket } from 'ws';

import {
  type ExecResult,
  NODE_EXEC_CLOSEOUT_MS,
  type NodeExecParams,
  observeNodeExecAbort,
} from '@farmslot/protocol';

import { isLocal, loadSlotVars } from '../core/index.js';

import { type ConnectedNode, getNode } from './machine-registry.js';

let reqSeq = 0;
interface PendingNodeRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  responseSocket?: WebSocket;
  /** The error a plain bound request fails with when its connection closes. */
  connectionClosed?(): Error;
  cleanup?(): void;
}
const pending = new Map<string, PendingNodeRequest>();

// Per-request output listeners for streaming exec output
const outputListeners = new Map<string, (stream: string, data: string) => void>();

/**
 * Executions that failed unconfirmed after a timeout: the node still owes their result on the
 * original connection. It replies only once the process closed (or never spawned), so that late
 * result confirms closeout.
 */
const owedCloseouts = new Map<string, { socket: WebSocket; confirm: () => void }>();

function awaitOwedCloseout(id: string, socket: WebSocket): Promise<void> {
  return new Promise((confirm) => owedCloseouts.set(id, { socket, confirm }));
}

function takePendingRequest(id: string): PendingNodeRequest | undefined {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  outputListeners.delete(id);
  if (request.timer) clearTimeout(request.timer);
  request.cleanup?.();
  return request;
}

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
  source?: WebSocket,
  errorDetails?: unknown,
): void {
  const entry = pending.get(id);
  if (!entry) {
    const owed = owedCloseouts.get(id);
    if (owed && owed.socket === source) {
      owedCloseouts.delete(id);
      owed.confirm();
    }
    return;
  }
  // Native mutations cannot accept replies from another node or a replacement connection.
  if (entry.responseSocket && entry.responseSocket !== source) return;
  takePendingRequest(id);
  if (ok) {
    entry.resolve(payload);
  } else {
    const error = new Error(errorMsg || 'Node error') as NodeJS.ErrnoException & {
      details?: unknown;
    };
    if (errorCode) error.code = errorCode;
    if (errorDetails !== undefined) error.details = errorDetails;
    entry.reject(error);
  }
}

/**
 * A node connection closed. A plain request bound to it accepts its reply only
 * from that connection, so it can never be answered: fail it now instead of at
 * its timeout. Streaming exec requests settle through their own close handling.
 */
export function failRequestsBoundTo(ws: WebSocket): void {
  // A closed connection can no longer deliver what it owed; readers re-probe on its replacement.
  for (const [id, owed] of owedCloseouts) if (owed.socket === ws) owedCloseouts.delete(id);
  for (const [id, entry] of pending) {
    if (entry.responseSocket === ws && entry.connectionClosed)
      takePendingRequest(id)?.reject(entry.connectionClosed());
  }
}

/**
 * Route a node.exec.output event to the registered listener for that request.
 */
export function handleNodeExecOutput(
  requestId: string,
  stream: string,
  data: string,
  source?: WebSocket,
): void {
  const owner = pending.get(requestId)?.responseSocket;
  if (owner && owner !== source) return;
  const listener = outputListeners.get(requestId);
  if (listener) listener(stream, data);
}

/**
 * The node RPC deadline elapsed before the node answered.
 *
 * A fact about the TRANSPORT, not about whatever was being asked. Callers that
 * classify a remote probe need to tell it apart from a real verdict: a runner
 * liveness probe that never got an answer says nothing about that runner's
 * recovery capability, and reporting it as one turned a loaded machine into a
 * permanent-looking refusal (MANUAL-000121).
 *
 * Typed rather than matched on the message, so the classification survives a
 * reworded error.
 */
export type NodeTransportUnavailableReason =
  | 'not-connected'
  | 'disconnected'
  | 'timeout'
  | 'connection-replaced';

/** Transport evidence only. Remote error codes never instantiate this local error. */
export class NodeTransportUnavailableError extends Error {
  readonly code = 'NODE_TRANSPORT_UNAVAILABLE';
  constructor(
    readonly machine: string,
    readonly reason: NodeTransportUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'NodeTransportUnavailableError';
  }
}

export function isNodeTransportUnavailableError(
  error: unknown,
): error is NodeTransportUnavailableError {
  return error instanceof NodeTransportUnavailableError;
}

export class NodeRpcTimeoutError extends NodeTransportUnavailableError {
  constructor(
    machine: string,
    readonly timeoutMs: number,
    detail = '',
  ) {
    super(machine, 'timeout', `Node ${machine} timeout after ${timeoutMs}ms${detail}`);
    this.name = 'NodeRpcTimeoutError';
  }
}

/** The command was sent, but its original connection did not confirm process closeout. */
export class NodeExecUnconfirmedError extends NodeTransportUnavailableError {
  readonly #executionConnection: WebSocket | undefined;

  constructor(
    machine: string,
    readonly requestId: string,
    reason: NodeTransportUnavailableReason,
    executionConnection?: WebSocket,
    /** Settles when the node later delivers this execution's result on its original connection. */
    readonly closeout: Promise<void> = new Promise(() => {}),
  ) {
    super(
      machine,
      reason,
      `Execution ${requestId} on ${machine} has unconfirmed closeout (${reason}); preserve its resources until verified.`,
    );
    this.name = 'NodeExecUnconfirmedError';
    this.#executionConnection = executionConnection;
  }

  get executionConnection(): WebSocket | undefined {
    return this.#executionConnection;
  }
}

/**
 * Send an RPC request to a connected node and await the response.
 */
export function sendNodeRequest(
  node: ConnectedNode,
  method: string,
  params: unknown,
  opts?: { timeout?: number; onRequestId?: (id: string) => void; requireSameConnection?: boolean },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (node.ws.readyState !== WebSocket.OPEN) {
      return reject(
        new NodeTransportUnavailableError(
          node.machine,
          'disconnected',
          `Node ${node.machine} WebSocket not open`,
        ),
      );
    }
    const id = `gw-${++reqSeq}-${Date.now()}`;
    const TIMEOUT = opts?.timeout ?? 30_000;
    const timer = setTimeout(() => {
      takePendingRequest(id)?.reject(new NodeRpcTimeoutError(node.machine, TIMEOUT));
    }, TIMEOUT);
    pending.set(id, {
      resolve,
      reject,
      timer,
      ...(opts?.requireSameConnection
        ? {
            responseSocket: node.ws,
            connectionClosed: () =>
              new NodeTransportUnavailableError(
                node.machine,
                'disconnected',
                `Node ${node.machine} connection closed before it replied`,
              ),
          }
        : {}),
    });
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
interface StreamingRequestOptions {
  timeout?: number;
  onOutput?: (stream: string, data: string) => void;
  signal?: AbortSignal;
  closeoutTimeoutMs?: number;
}

function sendNodeRequestStreaming(
  node: ConnectedNode,
  method: string,
  params: unknown,
  opts?: StreamingRequestOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (opts?.signal?.aborted) return reject(new Error('Remote execution cancelled before send.'));
    if (node.ws.readyState !== WebSocket.OPEN) {
      return reject(
        new NodeTransportUnavailableError(
          node.machine,
          'disconnected',
          `Node ${node.machine} WebSocket not open`,
        ),
      );
    }
    const id = `gw-${++reqSeq}-${Date.now()}`;
    const effectiveTimeout = opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;
    let cancelling = false;
    let stopObservingAbort = () => {};
    const fail = (reason: NodeTransportUnavailableReason) => {
      takePendingRequest(id)?.reject(
        new NodeExecUnconfirmedError(
          node.machine,
          id,
          reason,
          node.ws,
          reason === 'timeout' ? awaitOwedCloseout(id, node.ws) : undefined,
        ),
      );
    };
    const cancel = () => {
      const request = pending.get(id);
      if (!request || cancelling) return;
      cancelling = true;
      if (node.ws.readyState !== WebSocket.OPEN) return fail('disconnected');
      if (request.timer) clearTimeout(request.timer);
      request.timer = setTimeout(
        () => fail('timeout'),
        (opts?.closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS) + NODE_EXEC_TRANSPORT_GRACE_MS,
      );
      // The acknowledgement is not completion; only the original exec result settles this request.
      try {
        node.ws.send(
          JSON.stringify({
            type: 'req',
            id: `cancel-${id}`,
            method: 'exec.cancel',
            params: { requestId: id },
          }),
          (error) => {
            if (error) fail('disconnected');
          },
        );
      } catch {
        fail('disconnected');
      }
    };
    const onClose = () => fail('disconnected');
    const timer = setTimeout(() => {
      if (opts?.signal) cancel();
      else {
        const suffix =
          opts?.timeout == null
            ? ' (default — caller should pass explicit timeout for long ops)'
            : '';
        takePendingRequest(id)?.reject(
          new NodeRpcTimeoutError(node.machine, effectiveTimeout, suffix),
        );
      }
    }, effectiveTimeout);
    if (opts?.onOutput) outputListeners.set(id, opts.onOutput);
    pending.set(id, {
      resolve,
      reject,
      timer,
      ...(opts?.signal
        ? {
            responseSocket: node.ws,
            cleanup: () => {
              stopObservingAbort();
              node.ws.off('close', onClose);
            },
          }
        : {}),
    });
    if (opts?.signal) {
      node.ws.once('close', onClose);
      stopObservingAbort = observeNodeExecAbort(opts.signal, cancel);
    }
    const sendFailed = (error: Error) => {
      if (opts?.signal) fail('disconnected');
      else
        takePendingRequest(id)?.reject(
          new NodeTransportUnavailableError(
            node.machine,
            'disconnected',
            `Node ${node.machine} send failed: ${error.message}`,
          ),
        );
    };
    try {
      node.ws.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {
        if (error) sendFailed(error);
      });
    } catch (error) {
      sendFailed(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const reconnectWait = new AsyncLocalStorage<{ assertCurrent: () => void; deadline?: number }>();

export function assertNodeReconnectCurrent(): void {
  reconnectWait.getStore()?.assertCurrent();
}

/** Pipeline preparation waits for reconnect before sending, never by replaying a command. */
export function withNodeReconnectWait<T>(
  operation: () => Promise<T>,
  assertCurrent: () => void,
): Promise<T> {
  return reconnectWait.run({ assertCurrent }, operation);
}

/** Owned teardown must still run after forward execution was cancelled. */
export function withoutNodeReconnectWait<T>(operation: () => Promise<T>): Promise<T> {
  return reconnectWait.exit(operation);
}

/** Revalidate native authority after a pre-send reconnect, never retry a sent request. */
export function resolveAfterNodeReconnect<T>(machine: string, resolve: () => T): T | Promise<T> {
  assertNodeReconnectCurrent();
  try {
    return resolve();
  } catch (error) {
    if (!reconnectWait.getStore() || !isNodeTransportUnavailableError(error)) throw error;
    return waitForNode(machine).then(() => {
      assertNodeReconnectCurrent();
      return resolve();
    });
  }
}

export async function waitForNode(
  machine: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<ConnectedNode> {
  const scope = reconnectWait.getStore();
  const check = () => {
    scope?.assertCurrent();
    if (signal?.aborted) throw new Error('Remote execution cancelled before connecting.');
  };
  check();
  const connected = getNode(machine);
  if (connected?.ws.readyState === WebSocket.OPEN) {
    if (scope) scope.deadline = undefined;
    return connected;
  }
  if (scope) timeoutMs = 120_000;
  const deadline = scope ? (scope.deadline ??= Date.now() + timeoutMs) : Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check();
    const node = getNode(machine);
    if (node && node.ws.readyState === WebSocket.OPEN) {
      if (scope) scope.deadline = undefined;
      return node;
    }
    await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
  }
  check();
  throw new NodeTransportUnavailableError(
    machine,
    'not-connected',
    `No node connected for machine ${machine} after ${timeoutMs}ms`,
  );
}

/**
 * Margin the transport deadline gets on top of the remote command's own budget.
 *
 * The two used to be the same number, so the transport almost always gave up
 * first: the node still has to fire its own timeout, escalate to SIGKILL after
 * the five-second grace `execLocal` allows, and send the result back. The
 * caller then saw a transport failure instead of the command's exit 124, and a
 * probe timeout lost the one fact that identified it. Giving the transport the
 * longer deadline lets the command's own timer win and report itself.
 */
const NODE_EXEC_TRANSPORT_GRACE_MS = 10_000;

export interface NodeExecOpts {
  /** Scope the request to its original node connection and wait for closeout on abort. */
  signal?: AbortSignal;
  closeoutTimeoutMs?: number;
  timeout?: number;
  onOutput?: (stream: string, data: string) => void;
  maxBuffer?: number;
  /** Fail instead of resending after a lost reply: the command may already have run. */
  noRetry?: boolean;
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
    const node = await waitForNode(machine, 15_000, opts?.signal);
    assertNodeReconnectCurrent();
    if (opts?.signal?.aborted) throw new Error('Remote execution cancelled before send.');
    if (opts?.signal && !node.execCancellation) {
      throw new Error(`Node ${machine} needs an update before it can run cancellable commands.`);
    }
    try {
      return (await sendNodeRequestStreaming(
        node,
        'exec',
        {
          ...request,
          ...(opts?.signal
            ? {
                requestScoped: true,
                closeoutTimeoutMs: opts.closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS,
              }
            : {}),
          ...(opts?.timeout != null ? { timeout: opts.timeout } : {}),
          ...(opts?.maxBuffer != null ? { maxBuffer: opts.maxBuffer } : {}),
        },
        {
          // Deliberately NOT the command budget: see NODE_EXEC_TRANSPORT_GRACE_MS.
          ...(opts?.timeout != null
            ? {
                timeout:
                  opts.timeout +
                  NODE_EXEC_TRANSPORT_GRACE_MS +
                  (opts.signal ? (opts.closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS) : 0),
              }
            : {}),
          onOutput: opts?.onOutput,
          signal: opts?.signal,
          closeoutTimeoutMs: opts?.closeoutTimeoutMs,
        },
      )) as ExecResult;
    } catch (err) {
      const msg = (err as Error).message;
      if (
        attempt === 0 &&
        !opts?.noRetry &&
        !opts?.signal &&
        (msg.includes('not open') || err instanceof NodeRpcTimeoutError)
      ) {
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
