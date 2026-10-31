import type { TerminalInputSequence } from '@farmslot/protocol';

export class TerminalInputCancelledError extends Error {
  constructor() {
    super('Terminal input cancelled because the connection or target changed');
    this.name = 'TerminalInputCancelledError';
  }
}

interface InputWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface InputBatch {
  data: string;
  waiters: InputWaiter[];
}

interface NumberedBatch extends InputBatch {
  seq: TerminalInputSequence;
}

export interface TerminalInputQueue {
  write: (data: string) => Promise<void>;
  /** Sends held input again, ahead of anything typed since. */
  resend: () => void;
  /** Drops held input; anything typed since goes out. */
  discard: () => void;
  dispose: () => void;
}

/** A terminal's input: `write` queues keys; `resend` and `discard` settle held input. */
export interface TerminalInput {
  write: (data: string) => Promise<void>;
  resend: () => void;
  discard: () => void;
}

/** Input whose request reached the socket and then failed, so the pane may already have it. */
export interface HeldTerminalInput {
  data: string;
  error: unknown;
}

export interface TerminalInputQueueOptions {
  /** Called after each failed request, before its retry. */
  onRetry?: (error: unknown, attempt: number) => void;
  /** Input is held, or (`null`) no longer held after a resend or discard. */
  onHold?: (held: HeldTerminalInput | null) => void;
  /** Wait before retry `attempt` (0 for the first). */
  retryDelayMs?: (attempt: number) => number;
  /**
   * True when the gateway writes each sequence number once (`terminalInputSequence`), so a batch
   * whose reply was lost can be resent as is. Without it, such a batch is held instead.
   */
  resendsAreSafe?: () => boolean;
  /** This queue's input stream; random by default. */
  stream?: string;
}

/** Shown once a request has failed twice; cleared when the keys go through. */
const KEYS_RETRYING_MESSAGE = 'Keys not delivered yet, retrying in order';

/** The notice for retry `attempt` of keys not yet sent, or null while it is still a blip. */
export function keysRetryingNotice(error: unknown, attempt: number): string | null {
  if (attempt < 1) return null;
  return `${KEYS_RETRYING_MESSAGE}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Clears the keys-retrying notice once the keys go through; any other error stays. */
export function withoutKeysRetryingNotice(current: string | null): string | null {
  return current?.startsWith(KEYS_RETRYING_MESSAGE) ? null : current;
}

const retryBackoffMs = (attempt: number) => Math.min(250 * 2 ** attempt, 4_000);

/**
 * Live input. One request at a time; keys typed while it is on its way share the next one, and
 * each batch is numbered in this queue's stream. A keystroke is never dropped or typed twice:
 * - when the gateway writes each number once, a failed batch is resent as is (same keys, same
 *   number) until it goes through or the queue is disposed (the target or client changed); keys
 *   typed meanwhile form the next batch;
 * - with an older gateway, a batch that failed before it was sent (`markSent` not called) is
 *   retried merged with the keys behind it, and one that failed after it was sent may already be
 *   in the pane, so it is held: nothing else goes out until the user resends or discards it.
 */
export function createTerminalInputQueue(
  send: (
    data: string,
    assertActive: () => void,
    markSent: () => void,
    seq: TerminalInputSequence,
  ) => Promise<void>,
  {
    onRetry,
    onHold,
    retryDelayMs = retryBackoffMs,
    resendsAreSafe = () => false,
    stream = newStreamId(),
  }: TerminalInputQueueOptions = {},
): TerminalInputQueue {
  let disposed = false;
  let inFlight = false;
  let pending: InputBatch | null = null;
  let resending: NumberedBatch | null = null;
  let held: InputBatch | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let lastNumber = 0;

  const assertActive = () => {
    if (disposed) throw new TerminalInputCancelledError();
  };

  function takePending(): InputBatch | null {
    const batch = pending;
    pending = null;
    return batch;
  }

  /** Puts `batch` back ahead of the keys typed since. */
  function requeueFirst(batch: InputBatch) {
    const typedSince = takePending();
    pending = typedSince
      ? { data: batch.data + typedSince.data, waiters: [...batch.waiters, ...typedSince.waiters] }
      : batch;
  }

  function rejectPending(error: unknown) {
    takePending()?.waiters.forEach((waiter) => waiter.reject(error));
  }

  function nextBatch(): NumberedBatch | null {
    if (resending) {
      const batch = resending;
      resending = null;
      return batch;
    }
    const batch = takePending();
    return batch && { ...batch, seq: { stream, n: ++lastNumber } };
  }

  async function drain(): Promise<void> {
    if (inFlight || retryTimer || held || disposed) return;
    const batch = nextBatch();
    if (!batch) return;
    inFlight = true;
    let sent = false;
    try {
      await send(
        batch.data,
        assertActive,
        () => {
          sent = true;
        },
        batch.seq,
      );
      failures = 0;
      batch.waiters.forEach((waiter) => waiter.resolve());
    } catch (error) {
      if (disposed) {
        batch.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
        return;
      }
      if (resendsAreSafe()) resending = batch;
      else if (sent) {
        held = batch;
        onHold?.({ data: batch.data, error });
        return;
      } else requeueFirst(batch);
      onRetry?.(error, failures);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void drain();
      }, retryDelayMs(failures++));
    } finally {
      inFlight = false;
      void drain();
    }
  }

  return {
    write(data) {
      if (disposed) return Promise.reject(new TerminalInputCancelledError());
      return new Promise<void>((resolve, reject) => {
        if (pending) {
          pending.data += data;
          pending.waiters.push({ resolve, reject });
        } else {
          pending = { data, waiters: [{ resolve, reject }] };
        }
        void drain();
      });
    },
    resend() {
      if (!held || disposed) return;
      requeueFirst(held);
      held = null;
      failures = 0;
      onHold?.(null);
      void drain();
    },
    discard() {
      if (!held || disposed) return;
      held.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
      held = null;
      onHold?.(null);
      void drain();
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      for (const batch of [held, resending]) {
        batch?.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
      }
      if (held) onHold?.(null);
      held = null;
      resending = null;
      rejectPending(new TerminalInputCancelledError());
    },
  };
}

function newStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
