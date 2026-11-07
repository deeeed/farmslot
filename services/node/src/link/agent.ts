import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  type EventFrame,
  isNodeLinkCommand,
  NODE_LINK_LIMITS,
  type NodeLinkCommand,
  type NodeLinkCursor,
  NodeLinkFailure,
  type NodeLinkPrincipal,
  type NodeLinkProcessUpdate,
  type NodeLinkReceipt,
} from '@farmslot/protocol';

import { NodeLinkExecutor } from './executor.js';
import {
  NODE_LINK_OPERATIONS,
  parseNodeLinkOperation,
  parseNodeLinkTerminalSize,
} from './operations.js';
import { NodeLinkQueue } from './queue.js';
import { NodeLinkReplay } from './replay.js';

interface ProcessUpdate {
  kind: 'started' | 'output' | 'snapshot';
  stream?: 'stdout' | 'stderr';
  text: string;
  omittedCharacters?: number;
  commandId: string;
  state?: NodeLinkReceipt['state'];
}
interface PendingCommand {
  command: NodeLinkCommand;
  cancelled: boolean;
  started: boolean;
  result: Promise<NodeLinkReceipt>;
}

interface ProcessStream {
  command: NodeLinkCommand;
  journal: NodeLinkReplay<ProcessUpdate>;
  sent: NodeLinkCursor;
  acknowledged: number;
  credit: Map<number, number>;
  tail: string;
  omitted: number;
  state?: NodeLinkReceipt['state'];
  settledAt?: number;
  waiters: Array<{ offset: number; resolve(): void; reject(error: unknown): void }>;
}

function cursorValue(value: unknown): NodeLinkCursor {
  if (
    !value ||
    typeof value !== 'object' ||
    !('streamId' in value) ||
    typeof value.streamId !== 'string' ||
    !('incarnation' in value) ||
    typeof value.incarnation !== 'string' ||
    !('offset' in value) ||
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0
  )
    throw new NodeLinkFailure('INVALID_CURSOR', 'Invalid node stream cursor.');
  return { streamId: value.streamId, incarnation: value.incarnation, offset: value.offset };
}

/** Connection-scoped adapter inside the existing daemon, not another service or socket. */
export class NodeLinkAgent {
  readonly capabilities = {
    commands: 1 as const,
    streams: 1 as const,
    operations: NODE_LINK_OPERATIONS,
  };
  private readonly executor: NodeLinkExecutor;
  private readonly queue = new NodeLinkQueue();
  private readonly streams = new Map<string, ProcessStream>();
  private readonly pending = new Map<string, PendingCommand>();
  private flush?: ReturnType<typeof setTimeout>;
  private retired = false;
  private recovery?: Promise<void>;

  constructor(
    root: string,
    nodeId: string,
    principal: NodeLinkPrincipal,
    current: () => boolean,
    private readonly publish: (event: EventFrame) => boolean,
  ) {
    this.executor = new NodeLinkExecutor(
      root,
      nodeId,
      principal,
      current,
      (command, update, signal) => this.output(command, update, signal),
    );
  }

  async handle(method: string, value: unknown): Promise<unknown> {
    if (this.retired) throw new NodeLinkFailure('STALE_SOCKET', 'Node link is retired.');
    await (this.recovery ??= this.executor.commands.recoverInterrupted());
    if (method === 'node.link.status') return { ready: true, capabilities: this.capabilities };
    if (method === 'node.link.authorize') {
      this.pruneStreams();
      return this.executor.bind(value);
    }
    if (method === 'node.link.terminal.resize') {
      if (
        !value ||
        typeof value !== 'object' ||
        !('command' in value) ||
        !isNodeLinkCommand(value.command) ||
        !('size' in value)
      )
        throw new NodeLinkFailure(
          'INVALID_PARAMS',
          'Resize requires its original command and dimensions.',
        );
      this.executor.resizeTerminal(value.command, parseNodeLinkTerminalSize(value.size));
      return { resized: true };
    }
    if (!isNodeLinkCommand(value) && method !== 'node.link.resume' && method !== 'node.link.ack')
      throw new NodeLinkFailure('INVALID_PARAMS', 'Invalid node link command.');
    if (method === 'node.link.command') {
      this.pruneStreams();
      const command = parseNodeLinkOperation(value);
      this.executor.authorize(command);
      const previous = this.pending.get(command.commandId);
      if (previous) {
        if (!isDeepStrictEqual(previous.command, command))
          throw new NodeLinkFailure(
            'IDEMPOTENCY_CONFLICT',
            'Concurrent command arguments changed.',
          );
        return previous.result;
      }
      const bytes = Buffer.byteLength(JSON.stringify(command));
      const pending: PendingCommand = {
        command,
        cancelled: false,
        started: false,
        result: Promise.resolve<NodeLinkReceipt | undefined>(undefined).then(() =>
          this.queue.run(
            command.operation.startsWith('file.write') ? 'bulk' : 'interactive',
            bytes,
            command.expiresAt,
            () => {
              pending.started = true;
              return pending.cancelled
                ? this.executor.commands.cancelBeforeAdmission(command)
                : this.executor.commands.execute(command);
            },
            {
              key: command.commandId,
              result: () => this.executor.commands.cancelBeforeAdmission(command),
            },
          ),
        ),
      };
      this.pending.set(command.commandId, pending);
      let receipt: NodeLinkReceipt;
      try {
        receipt = await pending.result;
      } catch (error) {
        if (error instanceof NodeLinkFailure && error.details?.admitted === false)
          this.executor.release(command);
        throw error;
      } finally {
        if (this.pending.get(command.commandId) === pending) this.pending.delete(command.commandId);
      }

      const stream = this.streams.get(command.commandId);
      if (stream) {
        stream.state = receipt.state;
        if (receipt.closeoutConfirmed) stream.settledAt = Date.now();
        this.drain(stream);
      }
      return receipt;
    }
    if (method === 'node.link.release' && isNodeLinkCommand(value)) {
      let receipt: NodeLinkReceipt;
      try {
        receipt = await this.executor.commands.receipt(value);
      } catch (error) {
        if (!(error instanceof NodeLinkFailure && error.code === 'RECEIPT_UNKNOWN')) throw error;
        this.executor.release(value);
        return { released: true };
      }
      if (
        !receipt.closeoutConfirmed &&
        !(receipt.state === 'failed' && receipt.error?.code === 'OUTCOME_UNKNOWN')
      )
        throw new NodeLinkFailure('OUTCOME_UNKNOWN', 'Cannot release an unsettled command.');
      this.streams.delete(value.commandId);
      this.executor.release(value);
      return { released: true };
    }
    if (method === 'node.link.receipt' && isNodeLinkCommand(value))
      return this.executor.commands.receipt(value);
    if (method === 'node.link.cancel' && isNodeLinkCommand(value)) {
      this.executor.authorizeCloseout(value);
      const pending = this.pending.get(value.commandId);
      if (pending) {
        if (!isDeepStrictEqual(pending.command, value))
          throw new NodeLinkFailure('IDEMPOTENCY_CONFLICT', 'Cancellation arguments changed.');
        pending.cancelled = true;
        if (await this.queue.cancel(value.commandId)) return this.executor.commands.receipt(value);
        if (!pending.started) return pending.result;
      }
      return this.executor.commands.cancel(value);
    }
    if (method === 'node.link.resume' || method === 'node.link.ack') {
      if (
        !value ||
        typeof value !== 'object' ||
        !('command' in value) ||
        !isNodeLinkCommand(value.command) ||
        !('cursor' in value)
      )
        throw new NodeLinkFailure(
          'INVALID_PARAMS',
          'Stream control requires its authorized command and cursor.',
        );
      if (value.command.operation !== 'process.run')
        throw new NodeLinkFailure('UNSUPPORTED_OPERATION', 'Command has no process stream.');
      const cursor = cursorValue(value.cursor);
      const receipt = await this.executor.commands.receipt(value.command);
      const source = this.source(value.command);
      source.state = receipt.state;
      if (method === 'node.link.resume') return source.journal.resume(cursor);
      if (
        cursor.streamId !== source.sent.streamId ||
        cursor.incarnation !== source.sent.incarnation ||
        cursor.offset < source.acknowledged ||
        cursor.offset > source.sent.offset
      )
        throw new NodeLinkFailure(
          'INVALID_CURSOR',
          'Acknowledgment is not in the sent contiguous stream.',
        );
      source.acknowledged = cursor.offset;
      for (const offset of source.credit.keys())
        if (offset <= cursor.offset) source.credit.delete(offset);
      this.drain(source);
      return { acknowledged: source.acknowledged };
    }
    throw new NodeLinkFailure('UNSUPPORTED_OPERATION', 'Unknown node link method.');
  }

  async retire(): Promise<void> {
    this.retired = true;
    this.queue.retire();
    for (const source of this.streams.values())
      for (const waiter of source.waiters.splice(0))
        waiter.reject(new NodeLinkFailure('STALE_SOCKET', 'Output source retired.'));
    const closeout = this.executor.retire();
    if (this.flush) clearTimeout(this.flush);
    await closeout;
    this.streams.clear();
  }

  private pruneStreams(): void {
    for (const [id, stream] of this.streams) {
      if (
        !stream.settledAt ||
        (this.streams.size < NODE_LINK_LIMITS.inFlight && Date.now() - stream.settledAt < 60_000) ||
        stream.waiters.length
      )
        continue;
      this.streams.delete(id);
      this.executor.release(stream.command);
    }
  }

  private source(command: NodeLinkCommand): ProcessStream {
    const existing = this.streams.get(command.commandId);
    if (existing) return existing;
    if (this.streams.size >= NODE_LINK_LIMITS.inFlight)
      throw new NodeLinkFailure(
        'CAPACITY',
        'Stream capacity reached; release a settled stream first.',
      );
    const id = createHash('sha256').update(command.commandId).digest('hex');
    const journal = new NodeLinkReplay<ProcessUpdate>(
      id,
      command.target,
      command.authority,
      () => ({
        kind: 'snapshot',
        commandId: command.commandId,
        text: source.tail,
        omittedCharacters: source.omitted,
        ...(source.state ? { state: source.state } : {}),
      }),
    );
    const source: ProcessStream = {
      command,
      journal,
      sent: journal.cursor,
      acknowledged: 0,
      credit: new Map(),
      tail: '',
      omitted: 0,
      waiters: [],
    };
    this.streams.set(command.commandId, source);
    return source;
  }

  private async output(
    command: NodeLinkCommand,
    update: NodeLinkProcessUpdate,
    signal: AbortSignal,
  ): Promise<void> {
    const source = this.source(command);
    if (update.kind === 'started') {
      source.journal.append({ ...update, commandId: command.commandId });
      this.drain(source);
      return;
    }
    const { stream, text: data } = update;
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(data.length, offset + 8000);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const text = data.slice(offset, end);
      const combined = source.tail + text;
      source.omitted += Math.max(0, combined.length - 8000);
      source.tail = combined.slice(-8000);
      source.journal.append({ kind: 'output', stream, text, commandId: command.commandId });
      const through = source.journal.cursor.offset;
      this.drain(source);
      signal.throwIfAborted();
      if (source.sent.offset < through)
        await new Promise<void>((resolve, reject) => {
          const waiter = {
            offset: through,
            resolve: () => {
              signal.removeEventListener('abort', abort);
              resolve();
            },
            reject: (error: unknown) => {
              signal.removeEventListener('abort', abort);
              reject(error);
            },
          };
          const abort = () => {
            source.waiters = source.waiters.filter((pending) => pending !== waiter);
            waiter.reject(signal.reason);
          };
          source.waiters.push(waiter);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      offset = end;
    }
  }

  private delivered(source: ProcessStream): void {
    const pending = source.waiters;
    source.waiters = [];
    for (const waiter of pending) {
      if (waiter.offset <= source.sent.offset) waiter.resolve();
      else source.waiters.push(waiter);
    }
  }

  private drain(source: ProcessStream): void {
    if (this.retired) return;
    const next = source.journal.resume(source.sent);
    if (next.kind === 'reset') {
      const payload = { commandId: source.command.commandId, ...next };
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (this.publish({ type: 'event', event: 'node.link.stream', payload })) {
        source.sent = next.cursor;
        this.delivered(source);
        source.credit.clear();
        source.credit.set(next.cursor.offset, bytes);
      } else this.schedule();
      return;
    }
    for (const frame of next.frames) {
      const payload = { kind: 'frame', frame };
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      const outstanding = [...source.credit.values()].reduce((sum, size) => sum + size, 0);
      if (outstanding + bytes > NODE_LINK_LIMITS.streamBytes) return;
      if (
        !this.publish({
          type: 'event',
          event: 'node.link.stream',
          payload,
        })
      ) {
        this.schedule();
        return;
      }
      source.credit.set(frame.offset, bytes);
      source.sent = {
        streamId: frame.streamId,
        incarnation: frame.incarnation,
        offset: frame.offset,
      };
      this.delivered(source);
    }
  }

  private schedule(): void {
    if (this.flush || this.retired) return;
    this.flush = setTimeout(() => {
      this.flush = undefined;
      for (const source of this.streams.values()) this.drain(source);
    }, 20);
    this.flush.unref();
  }
}
