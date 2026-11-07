import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  isNodeLinkCommand,
  isNodeLinkReceipt,
  isNodeLinkTerminal,
  NODE_LINK_LIMITS,
  NODE_LINK_RECEIPT_RETENTION_MS,
  type NodeLinkCommand,
  NodeLinkFailure,
  type NodeLinkReceipt,
} from '@farmslot/protocol';

export interface NodeLinkCommandExecutor {
  /** Recheck current socket, authority and resource fence on every read or admission. */
  authorize(command: NodeLinkCommand): void | Promise<void>;
  /** Original cleanup may stop its exact admitted command after effect authority changes. */
  authorizeCloseout?(command: NodeLinkCommand): void | Promise<void>;
  /** Resolve/reject only after authored teardown; uncertain closeout throws OUTCOME_UNKNOWN. */
  execute(command: NodeLinkCommand, signal: AbortSignal): Promise<unknown>;
  isReadOnly?(command: NodeLinkCommand): boolean;
}

type Admission = { ok: true } | { ok: false; error: unknown };

interface ActiveCommand {
  digest: string;
  controller: AbortController;
  receipt?: NodeLinkReceipt;
  result: Promise<NodeLinkReceipt>;
  admitted: Promise<Admission>;
  confirmAdmission(): void;
  failAdmission(error: unknown): void;
  writes: Promise<void>;
  cancelRequested: boolean;
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new NodeLinkFailure('INVALID_PARAMS', 'Command nesting exceeds its limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key), depth + 1)}`)
      .join(',')}}`;
  }
  throw new NodeLinkFailure('INVALID_PARAMS', 'Commands must contain finite JSON values.');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const copy = (receipt: NodeLinkReceipt): NodeLinkReceipt => structuredClone(receipt);
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** One durable key per command, including across reconnect and daemon restart. */
export class NodeLinkCommands {
  private readonly active = new Map<string, ActiveCommand>();
  private accepting = true;
  private lastPrune = 0;
  private pendingIndex?: Promise<Map<string, string>>;
  private indexWrites: Promise<{ ok: true } | { ok: false; error: unknown }> = Promise.resolve({
    ok: true,
  });

  constructor(
    private readonly root: string,
    private readonly executor: NodeLinkCommandExecutor,
    private readonly capacity = 4096,
  ) {}

  /** Boot recovery records uncertainty as a failed effect. Only domain replay may retry it. */
  async recoverInterrupted(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let index: Map<string, string>;
    try {
      index = await this.index();
    } catch (error) {
      if (!(error instanceof NodeLinkFailure && error.code === 'RECEIPT_INDEX_MISSING'))
        throw error;
      index = new Map<string, string>();
      for (const entry of await readdir(this.root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const value: unknown = JSON.parse(await readFile(path.join(this.root, entry), 'utf8'));
        if (!isNodeLinkReceipt(value))
          throw new NodeLinkFailure('RECEIPT_CORRUPT', 'Interrupted receipt failed validation.');
        if (!isNodeLinkTerminal(value.state)) index.set(value.commandId, this.resource(value));
      }
      this.pendingIndex = Promise.resolve(index);
      await this.write(path.join(this.root, 'pending.json'), [...index]);
    }
    for (const id of [...index.keys()]) {
      const receipt = await this.read(id);
      if (!receipt) throw new NodeLinkFailure('RECEIPT_CORRUPT', 'Interrupted receipt is missing.');
      if (isNodeLinkTerminal(receipt.state)) {
        await this.indexReceipt(receipt);
        continue;
      }
      const failed: NodeLinkReceipt = {
        ...receipt,
        state: 'failed',
        settledAt: Date.now(),
        closeoutConfirmed: false,
        error: {
          code: 'OUTCOME_UNKNOWN',
          message:
            'Node restarted before the effect outcome was confirmed. The owning run step failed; use its existing replay action to retry.',
        },
      };
      await this.write(this.file(id), failed);
      await this.indexReceipt(failed);
    }
  }

  execute(request: NodeLinkCommand): Promise<NodeLinkReceipt> {
    return this.executeMode(request, false);
  }

  cancelBeforeAdmission(request: NodeLinkCommand): Promise<NodeLinkReceipt> {
    return this.executeMode(request, true);
  }

  private async executeMode(
    request: NodeLinkCommand,
    cancelRequested: boolean,
  ): Promise<NodeLinkReceipt> {
    if (!this.accepting) throw new NodeLinkFailure('STALE_SOCKET', 'Command owner is retired.');
    const command = structuredClone(request);
    if (!isNodeLinkCommand(command))
      throw new NodeLinkFailure('INVALID_PARAMS', 'Invalid command envelope.');
    const serialized = canonical(command);
    if (Buffer.byteLength(serialized) > NODE_LINK_LIMITS.frameBytes)
      throw new NodeLinkFailure('FRAME_TOO_LARGE', 'Command exceeds the link frame limit.');
    const digest = sha256(serialized);
    const previous = this.active.get(command.commandId);
    if (previous) {
      await this.executor.authorize(command);
      this.assertDigest(previous.digest, digest);
      return copy(await previous.result);
    }
    let confirmAdmission!: () => void;
    let failAdmission!: (error: unknown) => void;
    const admitted = new Promise<Admission>((resolve) => {
      confirmAdmission = () => resolve({ ok: true });
      failAdmission = (error) => resolve({ ok: false, error });
    });
    const held: ActiveCommand = {
      digest,
      controller: new AbortController(),
      result: Promise.resolve(undefined).then(() => this.run(command, digest, held)),
      admitted,
      confirmAdmission,
      failAdmission,
      writes: Promise.resolve(),
      cancelRequested,
    };
    this.active.set(command.commandId, held);
    try {
      return copy(await held.result);
    } finally {
      if (this.active.get(command.commandId) === held) this.active.delete(command.commandId);
    }
  }

  /** Admission is separate from outcome, including when a command is still executing. */
  async admitted(command: NodeLinkCommand): Promise<void> {
    const held = this.active.get(command.commandId);
    if (!held) {
      await this.receipt(command);
      return;
    }
    const admission = await held.admitted;
    if (!admission.ok) throw admission.error;
  }

  async receipt(command: NodeLinkCommand): Promise<NodeLinkReceipt> {
    await this.authorizeCloseout(command);
    const stored = await this.read(command.commandId);
    if (!stored)
      throw new NodeLinkFailure(
        'RECEIPT_UNKNOWN',
        'No retained outcome; reconcile before executing.',
      );
    this.assertDigest(stored.digest, sha256(canonical(command)));
    const held = this.active.get(command.commandId);
    if (!held && !isNodeLinkTerminal(stored.state))
      return { ...stored, state: 'unknown', closeoutConfirmed: false };
    return copy(stored);
  }

  async cancel(command: NodeLinkCommand): Promise<NodeLinkReceipt> {
    const held = this.active.get(command.commandId);
    if (!held) return this.receipt(command);
    await this.authorizeCloseout(command);
    this.assertDigest(held.digest, sha256(canonical(command)));
    held.cancelRequested = true;
    const admission = await held.admitted;
    if (!admission.ok) throw admission.error;
    const receipt = held.receipt;
    if (!receipt) return this.receipt(command);
    if (isNodeLinkTerminal(receipt.state)) {
      await held.writes;
      return copy(receipt);
    }
    held.receipt = { ...receipt, state: 'cancel-requested', closeoutConfirmed: false };
    await this.persist(held);
    held.controller.abort();
    return copy(held.receipt);
  }

  /** Infrastructure executions retain their authored closeout when their socket retires. */
  async retire(): Promise<void> {
    this.accepting = false;
    const outcomes = await Promise.allSettled(
      [...this.active.values()].map(async (held) => {
        const admission = await held.admitted;
        if (!admission.ok) return; // Admission failed before its executor started.
        if (held.receipt && !isNodeLinkTerminal(held.receipt.state)) {
          held.receipt = { ...held.receipt, state: 'cancel-requested', closeoutConfirmed: false };
          try {
            await this.persist(held);
          } finally {
            held.controller.abort();
          }
        }
        const receipt = await held.result;
        if (!receipt.closeoutConfirmed)
          throw new NodeLinkFailure(
            'OUTCOME_UNKNOWN',
            'Retired execution still has unconfirmed closeout.',
          );
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'Node link cleanup remains unconfirmed.');
  }

  private authorizeCloseout(command: NodeLinkCommand): void | Promise<void> {
    return this.executor.authorizeCloseout
      ? this.executor.authorizeCloseout(command)
      : this.executor.authorize(command);
  }

  private assertDigest(previous: string, next: string): void {
    if (previous !== next)
      throw new NodeLinkFailure(
        'IDEMPOTENCY_CONFLICT',
        'Command key is already bound to different arguments or authority.',
      );
  }

  private file(id: string): string {
    return path.join(this.root, `${sha256(id)}.json`);
  }

  private async read(id: string): Promise<NodeLinkReceipt | undefined> {
    let handle;
    try {
      handle = await open(this.file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > NODE_LINK_LIMITS.frameBytes)
        throw new NodeLinkFailure(
          'RECEIPT_CORRUPT',
          'Retained outcome is not a bounded regular file.',
        );
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!isNodeLinkReceipt(value) || value.commandId !== id)
        throw new NodeLinkFailure('RECEIPT_CORRUPT', 'Retained outcome failed validation.');
      return value;
    } finally {
      await handle.close();
    }
  }

  private async write(file: string, receipt: unknown, create = false): Promise<void> {
    const bytes = JSON.stringify(receipt);
    if (Buffer.byteLength(bytes) > NODE_LINK_LIMITS.frameBytes)
      throw new NodeLinkFailure(
        'RESULT_TOO_LARGE',
        'Result requires a bounded stream or explicit range read.',
      );
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (create) {
      try {
        await link(temporary, file);
      } finally {
        await unlink(temporary);
      }
    } else await rename(temporary, file);
    const directory = await open(this.root, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private persist(held: ActiveCommand): Promise<void> {
    const receipt = held.receipt;
    if (!receipt) throw new Error('No admitted receipt');
    held.writes = held.writes.then(async () => {
      await this.write(this.file(receipt.commandId), receipt);
      await this.indexReceipt(receipt);
    });
    return held.writes;
  }

  private index(): Promise<Map<string, string>> {
    return (this.pendingIndex ??= (async () => {
      let handle;
      try {
        handle = await open(
          path.join(this.root, 'pending.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (missing(error)) {
          if ((await readdir(this.root)).some((name) => /^[a-f0-9]{64}\.json$/.test(name)))
            throw new NodeLinkFailure(
              'RECEIPT_INDEX_MISSING',
              'Retained commands have no pending-resource index; reconcile before admission.',
            );
          return new Map<string, string>();
        }
        throw error;
      }
      try {
        if ((await handle.stat()).size > NODE_LINK_LIMITS.frameBytes)
          throw new NodeLinkFailure('RECEIPT_CORRUPT', 'Pending resource index exceeds its bound.');
        const value: unknown = JSON.parse(await handle.readFile('utf8'));
        if (
          !Array.isArray(value) ||
          value.some(
            (entry) =>
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== 'string' ||
              typeof entry[1] !== 'string',
          )
        )
          throw new NodeLinkFailure('RECEIPT_CORRUPT', 'Pending resource index is invalid.');
        const entries = new Map<string, string>();
        for (const entry of value) entries.set(entry[0], entry[1]);
        return entries;
      } finally {
        await handle.close();
      }
    })());
  }

  private resource(command: Pick<NodeLinkCommand, 'target'>): string {
    return JSON.stringify([command.target.nodeId, command.target.resourceId]);
  }

  private indexReceipt(receipt: NodeLinkReceipt): Promise<void> {
    const write = this.indexWrites.then(async (previous) => {
      if (!previous.ok) throw previous.error;
      const index = await this.index();
      if (
        isNodeLinkTerminal(receipt.state) &&
        (receipt.closeoutConfirmed ||
          (receipt.state === 'failed' && receipt.error?.code === 'OUTCOME_UNKNOWN'))
      )
        index.delete(receipt.commandId);
      else index.set(receipt.commandId, this.resource(receipt));
      await this.write(path.join(this.root, 'pending.json'), [...index]);
    });
    this.indexWrites = write.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    return write;
  }

  private async assertResourceSettled(command: NodeLinkCommand): Promise<void> {
    const index = await this.index();
    if (this.executor.isReadOnly?.(command)) return;
    const resource = this.resource(command);
    for (const [id, target] of index) {
      if (target !== resource || id === command.commandId) continue;
      const active = this.active.get(id);
      if (active) {
        const receipt = active.receipt;
        if (
          !receipt ||
          receipt.state === 'cancel-requested' ||
          receipt.state === 'unknown' ||
          !isDeepStrictEqual(receipt.authority.lease, command.authority.lease) ||
          !isDeepStrictEqual(receipt.authority.executor, command.authority.executor)
        )
          throw new NodeLinkFailure(
            'RESOURCE_BUSY',
            'The original resource owner has not confirmed closeout.',
            { admitted: false },
          );
        continue;
      }
      const receipt = await this.read(id);
      if (receipt && isNodeLinkTerminal(receipt.state) && receipt.closeoutConfirmed) {
        await this.indexReceipt(receipt);
        continue;
      }
      throw new NodeLinkFailure(
        'RESOURCE_OUTCOME_UNKNOWN',
        `Resource retains unfinished command ${id}; reconcile before admitting a successor.`,
        { admitted: false },
      );
    }
  }

  /** Expired terminal envelopes cannot execute again; uncertain receipts are never evicted. */
  private async pruneSettled(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPrune < 30_000) return;
    this.lastPrune = now;
    for (const entry of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const file = path.join(this.root, entry);
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isNodeLinkReceipt(value))
        throw new NodeLinkFailure('RECEIPT_CORRUPT', 'Cannot prune an invalid receipt.');
      if (
        this.active.has(value.commandId) ||
        !isNodeLinkTerminal(value.state) ||
        !value.closeoutConfirmed ||
        !value.settledAt ||
        Math.max(value.expiresAt, value.settledAt) + NODE_LINK_RECEIPT_RETENTION_MS >= now
      )
        continue;
      await this.indexReceipt(value);
      await unlink(file);
    }
  }

  private async run(
    command: NodeLinkCommand,
    digest: string,
    held: ActiveCommand,
  ): Promise<NodeLinkReceipt> {
    try {
      if (held.cancelRequested) await this.authorizeCloseout(command);
      else await this.executor.authorize(command);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const stored = await this.read(command.commandId);
      if (stored) {
        this.assertDigest(stored.digest, digest);
        held.confirmAdmission();
        return isNodeLinkTerminal(stored.state)
          ? stored
          : { ...stored, state: 'unknown', closeoutConfirmed: false };
      }
      await this.index();
      if (!held.cancelRequested) await this.assertResourceSettled(command);
      if (
        !held.cancelRequested &&
        (!Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now())
      )
        throw new NodeLinkFailure('COMMAND_EXPIRED', 'Command expired before admission.', {
          admitted: false,
        });
      await this.pruneSettled(
        (await readdir(this.root)).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).length >=
          this.capacity,
      );
      if (
        (await readdir(this.root)).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).length >=
        this.capacity
      )
        throw new NodeLinkFailure(
          'CAPACITY',
          'Receipt capacity reached; uncertain keys are never evicted.',
          { admitted: false },
        );
      held.receipt = {
        commandId: command.commandId,
        digest,
        operation: command.operation,
        target: command.target,
        authority: command.authority,
        expiresAt: command.expiresAt,
        admittedAt: Date.now(),
        state: 'admitted',
        closeoutConfirmed: false,
      };
      try {
        await this.write(this.file(command.commandId), held.receipt, true);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const winner = await this.read(command.commandId);
        if (!winner)
          throw new NodeLinkFailure(
            'RECEIPT_UNKNOWN',
            'Concurrent admission requires reconciliation.',
          );
        this.assertDigest(winner.digest, digest);
        held.confirmAdmission();
        return isNodeLinkTerminal(winner.state)
          ? winner
          : { ...winner, state: 'unknown', closeoutConfirmed: false };
      }
      await this.indexReceipt(held.receipt);
      if (held.cancelRequested) await this.authorizeCloseout(command);
      else await this.executor.authorize(command);
      if (!held.cancelRequested && command.expiresAt <= Date.now())
        throw new NodeLinkFailure('COMMAND_EXPIRED', 'Command expired while awaiting admission.');
      if (held.cancelRequested) {
        held.receipt = {
          ...held.receipt,
          state: 'cancelled',
          closeoutConfirmed: true,
          settledAt: Date.now(),
        };
        await this.persist(held);
        held.confirmAdmission();
        return held.receipt;
      }
      held.receipt = { ...held.receipt, state: 'running' };
      await this.persist(held);
      const result = this.executor.execute(command, held.controller.signal);
      held.confirmAdmission();
      try {
        const value = await result;
        held.receipt = {
          ...held.receipt,
          state: held.controller.signal.aborted ? 'cancelled' : 'completed',
          result: value,
          closeoutConfirmed: true,
          settledAt: Date.now(),
        };
      } catch (error) {
        const uncertain = error instanceof NodeLinkFailure && error.code === 'OUTCOME_UNKNOWN';
        held.receipt = {
          ...held.receipt,
          state: uncertain ? 'unknown' : held.controller.signal.aborted ? 'cancelled' : 'failed',
          closeoutConfirmed: !uncertain,
          settledAt: Date.now(),
          error: {
            code: error instanceof NodeLinkFailure ? error.code : 'EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      await this.persist(held);
      return held.receipt;
    } catch (error) {
      // No executor started on this outer path. A persisted admission can close definitively.
      if (held.receipt && held.receipt.state === 'admitted') {
        held.receipt = {
          ...held.receipt,
          state: held.cancelRequested ? 'cancelled' : 'failed',
          closeoutConfirmed: true,
          settledAt: Date.now(),
          error: {
            code: error instanceof NodeLinkFailure ? error.code : 'ADMISSION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
        await this.persist(held);
        held.confirmAdmission();
        return held.receipt;
      }
      held.failAdmission(error);
      throw error;
    }
  }
}
