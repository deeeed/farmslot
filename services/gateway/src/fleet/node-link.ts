import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { WebSocket } from 'ws';

import {
  isNodeLinkCommand,
  isNodeLinkGrant,
  isNodeLinkReceipt,
  NODE_EXEC_CLOSEOUT_MS,
  NODE_LINK_LIMITS,
  NODE_LINK_RECEIPT_RETENTION_MS,
  type NodeLinkAuthority,
  type NodeLinkCommand,
  nodeLinkCommandDeadline,
  type NodeLinkCursor,
  NodeLinkFailure,
  type NodeLinkGrant,
  type NodeLinkOperationRequest,
  type NodeLinkReceipt,
  type NodeLinkTarget,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { assertCleanupCurrent } from '../core/cleanup-scope.js';
import { currentSessionOriginator } from '../security/work-originator.js';

import { type ConnectedNode, getNode } from './machine-registry.js';
import { usesNodeLink } from './node-link-policy.js';
import {
  awaitOwedCloseout,
  NodeExecUnconfirmedError,
  NodeTransportUnavailableError,
  retireBoundNodeRequest,
  sendNodeRequest,
} from './node-rpc.js';

export interface NodeLinkInvocation {
  /** Domain-owned stable key, including its existing workspace/operation generation. */
  commandId: string;
  target: NodeLinkTarget;
  authority: NodeLinkAuthority;
  root?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent(): void | Promise<void>;
  onStarted?(command: NodeLinkCommand): void;
  onOutput?(stream: 'stdout' | 'stderr', text: string): void;
  onReset?(snapshot: unknown): void;
}
interface NodeLinkIntent {
  command: NodeLinkCommand;
  grant: NodeLinkGrant;
  sent: boolean;
  receipt?: NodeLinkReceipt;
  observationReleasePending?: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function createNodeLinkCommandId(timeoutMs = 60_000): string {
  return `nl1:${Date.now() + timeoutMs}:${randomUUID()}`;
}

async function writeIntent(file: string, value: NodeLinkIntent): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** New mutation callers supply the key and domain fence; transport never invents a replay key. */
async function invokeUnqueued(
  request: NodeLinkOperationRequest,
  invocation: NodeLinkInvocation,
): Promise<NodeLinkReceipt> {
  const { operation, input } = request;
  if (Buffer.byteLength(JSON.stringify(request)) > NODE_LINK_LIMITS.frameBytes - 16 * 1024)
    throw new NodeLinkFailure('FRAME_TOO_LARGE', 'Operation requires bounded chunks.');
  assertCleanupCurrent();
  if (!usesNodeLink(invocation.target.nodeId))
    throw new NodeLinkFailure(
      'NODE_LINK_DISABLED',
      'Node-link pilot is disabled for this machine.',
    );
  await invocation.assertCurrent();
  const node = getNode(invocation.target.nodeId);
  if (
    !node ||
    node.nodeLink?.commands !== 1 ||
    !node.nodeLink.operations?.includes(operation) ||
    !node.nodePrincipal ||
    !node.observationAuthority?.()
  )
    throw new NodeLinkFailure(
      'UNSUPPORTED_OPERATION',
      'Configured node link is offline or lacks this operation.',
    );
  if (
    node.nodePrincipal.principalId !== invocation.authority.executor.principalId ||
    node.nodePrincipal.generation !== invocation.authority.executor.generation
  )
    throw new NodeLinkFailure(
      'STALE_AUTHORITY',
      'Invocation executor differs from its enrolled node.',
    );
  const assertCurrent = async () => {
    assertCleanupCurrent();
    await invocation.assertCurrent();
    invocation.signal?.throwIfAborted();
    if (getNode(node.machine) !== node || !node.observationAuthority?.())
      throw new NodeTransportUnavailableError(
        node.machine,
        'connection-replaced',
        'Node connection changed before admission.',
      );
  };
  const call = async (method: string, params: unknown): Promise<unknown> => {
    await assertCurrent();
    return await sendNodeRequest(node, method, params, {
      timeout: invocation.timeoutMs ?? 60_000,
      requireSameConnection: true,
    });
  };
  await ready(node, call, assertCurrent);
  const file = path.join(
    farmslotHome(),
    'node-link-intents',
    encodeURIComponent(node.machine),
    `${sha256(invocation.commandId)}.json`,
  );
  let intent: NodeLinkIntent;
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isIntent(value))
      throw new NodeLinkFailure('INTENT_CORRUPT', 'Stored node command requires reconciliation.');
    intent = value;
    if (
      intent.command.operation !== operation ||
      !isDeepStrictEqual(intent.command.input, input) ||
      !isDeepStrictEqual(intent.command.authority, invocation.authority) ||
      !isDeepStrictEqual(intent.command.target, invocation.target)
    )
      throw new NodeLinkFailure(
        'IDEMPOTENCY_CONFLICT',
        'Stored invocation key has different input or authority.',
      );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const retained = (await readdir(path.dirname(file))).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    await pruneSettledIntents(path.dirname(file), file, retained.length >= 4096);
    if (
      (await readdir(path.dirname(file))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .length >= 4096
    )
      throw new NodeLinkFailure(
        'CAPACITY',
        'Gateway intent capacity reached; uncertain outcomes are retained.',
      );
    const expiresAt =
      nodeLinkCommandDeadline(invocation.commandId) ??
      Date.now() + (invocation.timeoutMs ?? 60_000);
    if (expiresAt <= Date.now())
      throw new NodeLinkFailure(
        'COMMAND_EXPIRED',
        'Expired command keys cannot be renewed after retention.',
      );
    const command: NodeLinkCommand = {
      commandId: invocation.commandId,
      operation,
      input,
      authority: invocation.authority,
      target: invocation.target,
      expiresAt,
    };
    intent = {
      command,
      sent: false,
      grant: {
        authority: invocation.authority,
        target: invocation.target,
        expiresAt,
        operations: [operation],
        ...(invocation.root ? { root: invocation.root } : {}),
        ...(request.operation === 'process.run' ? { process: request.input } : {}),
      },
    };
    await writeIntent(file, intent);
  }
  // The invocation's admission deadline is fixed. Renewing query authority cannot extend it.
  const grant = {
    ...intent.grant,
    expiresAt: Math.max(intent.grant.expiresAt, Date.now() + 60_000),
  };
  await call('node.link.authorize', grant);
  const heldInvocation = pendingInvocations.get(invocationKey(invocation));
  if (heldInvocation) heldInvocation.command = intent.command;
  let receipt: unknown = intent.receipt;
  if (!isNodeLinkReceipt(receipt) || !receipt.closeoutConfirmed) {
    if (intent.sent) receipt = await call('node.link.receipt', intent.command);
    else {
      intent.sent = true;
      await writeIntent(file, intent);
      let dispatched = false;
      let requestId: string | undefined;
      let response: Promise<unknown> | undefined;
      let cancelling: Promise<unknown> | undefined;
      let cancelled!: (outcome: Promise<unknown>) => void;
      const cancellation = new Promise<unknown>((resolve) => {
        cancelled = resolve;
      });
      const unconfirmed = (error: unknown) =>
        new NodeExecUnconfirmedError(
          node.machine,
          intent.command.commandId,
          error instanceof NodeTransportUnavailableError ? error.reason : 'timeout',
          node.ws,
          requestId ? awaitOwedCloseout(requestId, node.ws) : undefined,
        );
      const abort = () => {
        if (!dispatched || cancelling) return;
        cancelling = sendNodeRequest(node, 'node.link.cancel', intent.command, {
          timeout: 5000,
          requireSameConnection: true,
        }).then(
          async (outcome) => {
            if (!isNodeLinkReceipt(outcome) || outcome.commandId !== intent.command.commandId)
              throw unconfirmed(undefined);
            if (outcome.closeoutConfirmed) return outcome;
            // The cancellation ACK records intent. The original operation still owns teardown.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                response!,
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(unconfirmed(undefined)),
                    (request.operation === 'process.run'
                      ? (request.input.closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS)
                      : 0) + 5000,
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
          (error: unknown) => {
            throw unconfirmed(error);
          },
        );
        cancelled(cancelling);
      };
      invocation.signal?.addEventListener('abort', abort, { once: true });
      try {
        await assertCurrent();
        invocation.signal?.throwIfAborted();
        response = sendNodeRequest(node, 'node.link.command', intent.command, {
          timeout:
            (invocation.timeoutMs ?? 60_000) +
            (request.operation === 'process.run'
              ? (request.input.closeoutTimeoutMs ?? NODE_EXEC_CLOSEOUT_MS)
              : 0) +
            5000,
          requireSameConnection: true,
          onRequestId: (id) => {
            dispatched = true;
            requestId = id;
          },
        });
        receipt = await Promise.race([response, cancellation]);
      } catch (error) {
        const refused =
          error instanceof Error &&
          'details' in error &&
          error.details &&
          typeof error.details === 'object' &&
          'admitted' in error.details &&
          error.details.admitted === false;
        if (!dispatched || refused) {
          // A definitive refusal may retry this same key. Ambiguous delivery never can.
          intent.sent = false;
          try {
            await sendNodeRequest(node, 'node.link.release', intent.command, {
              timeout: 5000,
              requireSameConnection: true,
            });
          } catch (cleanup) {
            if (!(cleanup instanceof NodeTransportUnavailableError))
              throw new AggregateError([error, cleanup], 'Refused operation grant cleanup failed.');
            intent.observationReleasePending = true;
          }
          await writeIntent(file, intent);
          throw error;
        }
        throw unconfirmed(error);
      } finally {
        invocation.signal?.removeEventListener('abort', abort);
        if (requestId)
          retireBoundNodeRequest(
            requestId,
            node.ws,
            new NodeTransportUnavailableError(
              node.machine,
              'timeout',
              'Durable operation outcome is tracked by its command receipt.',
            ),
          );
      }
    }
  }
  if (!isNodeLinkReceipt(receipt) || receipt.commandId !== invocation.commandId)
    throw new NodeLinkFailure(
      'INVALID_RECEIPT',
      'Node did not confirm the requested command identity.',
    );
  intent.receipt = receipt;
  const pending = pendingInvocations.get(invocationKey(invocation));
  if (pending) {
    await pending.delivery;
    const acknowledged = await pending.acknowledgments;
    if (!acknowledged.ok) pending.deliveryError = acknowledged.error;
  }
  await writeIntent(file, intent);
  if (
    !receipt.closeoutConfirmed &&
    !(receipt.state === 'failed' && receipt.error?.code === 'OUTCOME_UNKNOWN')
  )
    throw new NodeExecUnconfirmedError(node.machine, intent.command.commandId, 'timeout', node.ws);
  await pruneSettledIntents(path.dirname(file), file);
  // Observation cleanup has its own durable status; it cannot change a known execution outcome.
  try {
    if (getNode(node.machine) !== node || !node.observationAuthority?.())
      throw new NodeTransportUnavailableError(
        node.machine,
        'connection-replaced',
        'Observation owner connection changed after confirmed closeout.',
      );
    await sendNodeRequest(node, 'node.link.release', intent.command, {
      requireSameConnection: true,
      timeout: 5000,
    });
    intent.observationReleasePending = false;
  } catch (error) {
    if (
      !(error instanceof NodeTransportUnavailableError) &&
      !(error instanceof Error && 'code' in error && error.code === 'STALE_AUTHORITY')
    )
      throw error;
    intent.observationReleasePending = true;
  }
  await writeIntent(file, intent);
  if (pending?.deliveryError) throw pending.deliveryError;
  const result = receipt.result;
  if (
    receipt.state === 'completed' &&
    result &&
    typeof result === 'object' &&
    'kind' in result &&
    result.kind === 'streamed-process-result'
  ) {
    if (
      !pending ||
      !('stdout' in result) ||
      !('stderr' in result) ||
      !('exitCode' in result) ||
      typeof result.exitCode !== 'number'
    )
      throw new NodeLinkFailure(
        'RESULT_EXPIRED',
        'Retained execution outcome has no complete output projection.',
      );
    const materialize = (stream: 'stdout' | 'stderr', expected: unknown) => {
      const text = pending.output[stream].join('');
      if (
        !expected ||
        typeof expected !== 'object' ||
        !('bytes' in expected) ||
        !('sha256' in expected) ||
        expected.bytes !== Buffer.byteLength(text) ||
        expected.sha256 !== sha256(text)
      )
        throw new NodeLinkFailure(
          'RESULT_EXPIRED',
          'Output window is incomplete; reconcile the known outcome without replay.',
        );
      return text;
    };
    return {
      ...receipt,
      result: {
        exitCode: result.exitCode,
        stdout: materialize('stdout', result.stdout),
        stderr: materialize('stderr', result.stderr),
      },
    };
  }
  return receipt;
}

const intentPrunes = new Map<string, number>();
async function pruneSettledIntents(
  directory: string,
  currentFile: string,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (intentPrunes.get(directory) ?? 0) < 30_000) return;
  intentPrunes.set(directory, now);
  for (const entry of await readdir(directory)) {
    const file = path.join(directory, entry);
    if (file === currentFile || !/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isIntent(value))
      throw new NodeLinkFailure('INTENT_CORRUPT', 'Cannot prune an invalid intent.');
    const receipt = value.receipt;
    if (
      nodeLinkCommandDeadline(value.command.commandId) !== value.command.expiresAt ||
      !receipt?.closeoutConfirmed ||
      !receipt.settledAt ||
      Math.max(value.command.expiresAt, receipt.settledAt) + NODE_LINK_RECEIPT_RETENTION_MS >=
        now ||
      pendingInvocations.has(
        invocationKey({ commandId: value.command.commandId, target: value.command.target }),
      )
    )
      continue;
    await unlink(file);
  }
}

/** A deliberate new domain attempt must settle its predecessor before choosing another key. */
export async function reconcileNodeLinkIntent(nodeId: string, commandId: string): Promise<void> {
  const file = path.join(
    farmslotHome(),
    'node-link-intents',
    encodeURIComponent(nodeId),
    `${sha256(commandId)}.json`,
  );
  let intent: NodeLinkIntent;
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isIntent(value))
      throw new NodeLinkFailure('INTENT_CORRUPT', 'Attempt outcome requires reconciliation.');
    intent = value;
  } catch (error) {
    // Attempt refs precede intent creation, and only expired settled intents are pruned.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!intent.sent || intent.receipt?.closeoutConfirmed) return;
  if (intent.receipt?.state === 'failed' && intent.receipt.error?.code === 'OUTCOME_UNKNOWN')
    throw new NodeLinkFailure('OUTCOME_UNKNOWN', intent.receipt.error.message);
  const node = getNode(nodeId);
  if (
    !node ||
    !node.observationAuthority?.() ||
    !node.nodePrincipal ||
    !isDeepStrictEqual(node.nodePrincipal, intent.command.authority.executor)
  )
    throw new NodeExecUnconfirmedError(nodeId, commandId, 'not-connected', node?.ws);
  await sendNodeRequest(
    node,
    'node.link.authorize',
    { ...intent.grant, expiresAt: Date.now() + 60_000 },
    { timeout: 5000, requireSameConnection: true },
  );
  const receipt = await sendNodeRequest(node, 'node.link.receipt', intent.command, {
    timeout: 5000,
    requireSameConnection: true,
  });
  if (
    isNodeLinkReceipt(receipt) &&
    receipt.commandId === commandId &&
    receipt.state === 'failed' &&
    receipt.error?.code === 'OUTCOME_UNKNOWN'
  ) {
    intent.receipt = receipt;
    await writeIntent(file, intent);
    throw new NodeLinkFailure('OUTCOME_UNKNOWN', receipt.error.message);
  }
  if (!isNodeLinkReceipt(receipt) || receipt.commandId !== commandId || !receipt.closeoutConfirmed)
    throw new NodeExecUnconfirmedError(nodeId, commandId, 'timeout', node.ws);
  intent.receipt = receipt;
  await writeIntent(file, intent);
  await sendNodeRequest(node, 'node.link.release', intent.command, {
    timeout: 5000,
    requireSameConnection: true,
  });
}

function isIntent(value: unknown): value is NodeLinkIntent {
  return (
    !!value &&
    typeof value === 'object' &&
    'command' in value &&
    isNodeLinkCommand(value.command) &&
    'grant' in value &&
    isNodeLinkGrant(value.grant) &&
    'sent' in value &&
    typeof value.sent === 'boolean' &&
    (!('receipt' in value) || value.receipt === undefined || isNodeLinkReceipt(value.receipt))
  );
}

interface PendingInvocation {
  request: NodeLinkOperationRequest;
  target: NodeLinkTarget;
  authority: NodeLinkAuthority;
  result: Promise<NodeLinkReceipt>;
  cursor?: NodeLinkCursor;
  acknowledgments: Promise<{ ok: true } | { ok: false; error: unknown }>;
  command?: NodeLinkCommand;
  deliveryError?: unknown;
  controller: AbortController;
  assertCurrent: NodeLinkInvocation['assertCurrent'];
  delivery: Promise<void>;
  queuedDeliveryBytes: number;
  output: { stdout: string[]; stderr: string[]; bytes: number };
  onStarted?: NodeLinkInvocation['onStarted'];
  onOutput?: NodeLinkInvocation['onOutput'];
  onReset?: NodeLinkInvocation['onReset'];
}
const pendingInvocations = new Map<string, PendingInvocation>();
const invocationKey = (invocation: Pick<NodeLinkInvocation, 'target' | 'commandId'>) =>
  JSON.stringify([farmslotHome(), invocation.target.nodeId, invocation.commandId]);

export async function invokeNodeLink(
  request: NodeLinkOperationRequest,
  invocation: NodeLinkInvocation,
): Promise<NodeLinkReceipt> {
  const key = invocationKey(invocation);
  const prior = pendingInvocations.get(key);
  if (prior) {
    if (
      !isDeepStrictEqual(prior.request, request) ||
      !isDeepStrictEqual(prior.target, invocation.target) ||
      !isDeepStrictEqual(prior.authority, invocation.authority)
    )
      throw new NodeLinkFailure(
        'IDEMPOTENCY_CONFLICT',
        'Concurrent invocation has different input or authority.',
      );
    await invocation.assertCurrent();
    return structuredClone(await prior.result);
  }
  const held: PendingInvocation = {
    output: { stdout: [], stderr: [], bytes: 0 },
    acknowledgments: Promise.resolve({ ok: true }),
    onStarted: invocation.onStarted ? AsyncLocalStorage.bind(invocation.onStarted) : undefined,
    onOutput: invocation.onOutput ? AsyncLocalStorage.bind(invocation.onOutput) : undefined,
    onReset: invocation.onReset ? AsyncLocalStorage.bind(invocation.onReset) : undefined,
    request: structuredClone(request),
    target: structuredClone(invocation.target),
    authority: structuredClone(invocation.authority),
    controller: new AbortController(),
    assertCurrent: AsyncLocalStorage.bind(invocation.assertCurrent),
    delivery: Promise.resolve(),
    queuedDeliveryBytes: 0,
    result: Promise.resolve().then(() =>
      invokeUnqueued(held.request, {
        ...invocation,
        target: held.target,
        authority: held.authority,
        signal: invocation.signal
          ? AbortSignal.any([invocation.signal, held.controller.signal])
          : held.controller.signal,
      }),
    ),
  };
  pendingInvocations.set(key, held);
  try {
    return structuredClone(await held.result);
  } finally {
    if (pendingInvocations.get(key) === held) pendingInvocations.delete(key);
  }
}

async function ready(
  node: ConnectedNode,
  call: (method: string, params: unknown) => Promise<unknown>,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await assertCurrent();
    const value = await call('node.link.status', {});
    if (value && typeof value === 'object' && 'ready' in value && value.ready === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new NodeLinkFailure(
    'NODE_LINK_NOT_READY',
    `Node ${node.machine} did not finish feature registration.`,
  );
}

/** Serialize application after the domain owner rechecks its lease, not merely its socket. */
export function acceptNodeLinkStream(socket: WebSocket, value: unknown): Promise<boolean> {
  const candidate = streamCandidate(socket, value);
  if (!candidate || candidate.deliveryError) return Promise.resolve(false);
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (candidate.queuedDeliveryBytes + bytes > NODE_LINK_LIMITS.streamBytes) {
    candidate.deliveryError = new NodeLinkFailure(
      'STREAM_BACKPRESSURE',
      'Authorized stream application queue is full.',
    );
    candidate.controller.abort(candidate.deliveryError);
    return Promise.resolve(false);
  }
  candidate.queuedDeliveryBytes += bytes;
  const applied = candidate.delivery.then(async () => {
    try {
      if (candidate.deliveryError) return false;
      await candidate.assertCurrent();
      return applyNodeLinkStream(socket, value);
    } finally {
      candidate.queuedDeliveryBytes -= bytes;
    }
  });
  const handled = applied.catch((error: unknown) => {
    candidate.deliveryError ??= error;
    candidate.controller.abort(candidate.deliveryError);
    return false;
  });
  candidate.delivery = handled.then(() => undefined);
  return handled;
}

function streamCandidate(socket: WebSocket, value: unknown): PendingInvocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const payload = value as Record<string, unknown>;
  const frame = payload.kind === 'frame' ? payload.frame : undefined;
  const data = frame && typeof frame === 'object' && 'payload' in frame ? frame.payload : undefined;
  const commandId =
    data && typeof data === 'object' && 'commandId' in data ? data.commandId : payload.commandId;
  if (typeof commandId !== 'string') return undefined;
  return [...pendingInvocations.values()].find((held) => {
    const node = getNode(held.target.nodeId);
    return (
      node?.ws === socket &&
      node.observationAuthority?.() &&
      held.request.operation === 'process.run' &&
      pendingInvocations.get(invocationKey({ commandId, target: held.target })) === held
    );
  });
}

/** Only the currently enrolled socket can publish into its pending authorized operation. */
function applyNodeLinkStream(socket: WebSocket, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  const frame = payload.kind === 'frame' ? payload.frame : undefined;
  const data = frame && typeof frame === 'object' && 'payload' in frame ? frame.payload : undefined;
  const commandId =
    data && typeof data === 'object' && 'commandId' in data ? data.commandId : payload.commandId;
  if (typeof commandId !== 'string') return false;
  const candidate = streamCandidate(socket, value);
  if (!candidate || candidate.deliveryError) return false;
  let cursor: NodeLinkCursor;
  if (payload.kind === 'frame') {
    if (
      !frame ||
      typeof frame !== 'object' ||
      !('target' in frame) ||
      !('authority' in frame) ||
      !isDeepStrictEqual(frame.target, candidate.target) ||
      !isDeepStrictEqual(frame.authority, candidate.authority) ||
      !('streamId' in frame) ||
      typeof frame.streamId !== 'string' ||
      !('incarnation' in frame) ||
      typeof frame.incarnation !== 'string' ||
      !('offset' in frame) ||
      typeof frame.offset !== 'number' ||
      !Number.isSafeInteger(frame.offset) ||
      frame.offset < 1 ||
      !data ||
      typeof data !== 'object' ||
      !('text' in data) ||
      typeof data.text !== 'string' ||
      !('stream' in data) ||
      (data.stream !== 'stdout' && data.stream !== 'stderr')
    )
      return false;
    cursor = { streamId: frame.streamId, incarnation: frame.incarnation, offset: frame.offset };
    if (
      candidate.cursor &&
      (candidate.cursor.streamId !== cursor.streamId ||
        candidate.cursor.incarnation !== cursor.incarnation)
    )
      candidate.deliveryError = new NodeLinkFailure(
        'SOURCE_REPLACED',
        'Output needs a bounded snapshot.',
      );
    if (candidate.cursor && cursor.offset <= candidate.cursor.offset) return true;
    if (cursor.offset !== (candidate.cursor?.offset ?? 0) + 1)
      candidate.deliveryError = new NodeLinkFailure(
        'STREAM_GAP',
        'Output is not contiguous; resynchronize before applying it.',
      );
    if (!candidate.deliveryError) {
      const limit =
        candidate.request.operation === 'process.run' ? candidate.request.input.maxOutputBytes : 0;
      const terminal =
        candidate.request.operation === 'process.run' &&
        candidate.request.input.terminal !== undefined;
      if (!terminal) candidate.output.bytes += Buffer.byteLength(data.text);
      if (candidate.output.bytes > limit)
        candidate.deliveryError = new NodeLinkFailure(
          'RESULT_TOO_LARGE',
          'Output exceeded its approved bound.',
        );
      else if (!terminal) candidate.output[data.stream].push(data.text);
      try {
        if ('kind' in data && data.kind === 'started') {
          if (!candidate.command) return false;
          candidate.onStarted?.(candidate.command);
        } else candidate.onOutput?.(data.stream, data.text);
      } catch (error) {
        candidate.deliveryError = error;
      }
    }
  } else if (payload.kind === 'reset') {
    const next = payload.cursor;
    if (
      !next ||
      typeof next !== 'object' ||
      !('streamId' in next) ||
      typeof next.streamId !== 'string' ||
      !('incarnation' in next) ||
      typeof next.incarnation !== 'string' ||
      !('offset' in next) ||
      typeof next.offset !== 'number' ||
      !Number.isSafeInteger(next.offset) ||
      next.offset < 0
    )
      return false;
    cursor = { streamId: next.streamId, incarnation: next.incarnation, offset: next.offset };
    if (candidate.onReset) {
      try {
        candidate.onReset(payload.snapshot);
      } catch (error) {
        candidate.deliveryError = error;
      }
    } else
      candidate.deliveryError = new NodeLinkFailure(
        'STREAM_RESET_REQUIRED',
        'Output consumer must replace its projection from the snapshot.',
      );
  } else return false;
  if (candidate.deliveryError) {
    candidate.controller.abort(candidate.deliveryError);
    return false;
  }
  candidate.cursor = cursor;
  const node = getNode(candidate.target.nodeId);
  if (!node || node.ws !== socket) return false;
  const command = candidate.command;
  if (!command) return false;
  candidate.acknowledgments = candidate.acknowledgments.then(async (previous) => {
    if (!previous.ok) return previous;
    try {
      await sendNodeRequest(
        node,
        'node.link.ack',
        { command, cursor },
        { requireSameConnection: true },
      );
      return { ok: true } as const;
    } catch (error) {
      candidate.deliveryError = error;
      candidate.controller.abort(error);
      return { ok: false, error } as const;
    }
  });
  return true;
}

/** Metadata has no mutation/replay ambiguity, but keeps the same authenticated node path. */
export async function inspectNodeLinkPrograms(
  machine: string,
  programs: string[],
): Promise<{ paths: Record<string, string | null> }> {
  const node = getNode(machine);
  if (!node?.nodePrincipal)
    throw new NodeLinkFailure(
      'UNSUPPORTED_OPERATION',
      'Node identity is unavailable for inventory.',
    );
  const principal = currentSessionOriginator();
  const id = createNodeLinkCommandId();
  const receipt = await invokeNodeLink(
    { operation: 'system.which', input: { programs } },
    {
      commandId: id,
      target: { nodeId: machine, resourceId: `inventory:${id}` },
      authority: {
        requester:
          principal.kind === 'principal'
            ? { principalId: principal.principalId, generation: principal.principalGeneration ?? 0 }
            : { kind: 'system' },
        executor: node.nodePrincipal,
        grantId: id,
        approvalId: id,
        approval: 'framework',
      },
      assertCurrent: () => {
        if (getNode(machine) !== node)
          throw new NodeLinkFailure('STALE_SOCKET', 'Inventory target changed.');
      },
    },
  );
  const result = receipt.result;
  if (
    receipt.state !== 'completed' ||
    !result ||
    typeof result !== 'object' ||
    !('paths' in result) ||
    !result.paths ||
    typeof result.paths !== 'object'
  )
    throw new NodeLinkFailure('INVALID_RECEIPT', 'Node binary inventory did not complete.');
  const paths: Record<string, string | null> = Object.create(null);
  for (const program of programs) {
    const value: unknown = Reflect.get(result.paths, program);
    if (value !== null && typeof value !== 'string')
      throw new NodeLinkFailure('INVALID_RECEIPT', 'Invalid binary inventory result.');
    paths[program] = value;
  }
  return { paths };
}
