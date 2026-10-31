import type { TerminalInputSequence } from '@farmslot/protocol';

export class TerminalInputCancelledError extends Error {
  constructor() {
    super('Terminal input cancelled because the connection or target changed');
    this.name = 'TerminalInputCancelledError';
  }
}

/**
 * Thrown by a send, before the frame is written, when a batch that may already be in the pane
 * would go to a gateway instance that cannot drop it as a repeat: the user decides instead.
 */
export class TerminalInputNeedsDecisionError extends Error {
  constructor() {
    super('This input may already have reached the terminal');
    this.name = 'TerminalInputNeedsDecisionError';
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
  /** Gateway instance an attempt was written to (null: one without deduplication). */
  sentTo?: string | null;
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
 * each batch is numbered in this queue's stream. Once numbered, a batch's keys never change: keys
 * typed later form the next batch. A keystroke is never dropped or typed twice on its own:
 * - a batch that failed before it was written (`markSent` not called) is resent as is;
 * - a batch written to a gateway instance that drops repeated numbers (`markSent(instance)`) is
 *   resent as is to that instance, which acknowledges it without typing it again;
 * - a batch written to a gateway without that (`markSent(null)`), one the gateway reports as
 *   uncertain (TERMINAL_INPUT_UNCERTAIN), or one that would go to another instance
 *   (`TerminalInputNeedsDecisionError`) may already be in the pane, so it is held: nothing else
 *   goes out until the user resends or discards it.
 */
export function createTerminalInputQueue(
  send: (
    data: string,
    assertActive: () => void,
    markSent: (instance?: string | null) => void,
    seq: TerminalInputSequence,
    sentTo: string | null | undefined,
  ) => Promise<void>,
  {
    onRetry,
    onHold,
    retryDelayMs = retryBackoffMs,
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

  /** Puts held keys back ahead of the keys typed since, as one new batch. */
  function requeueFirst(batch: InputBatch) {
    const typedSince = takePending();
    pending = typedSince
      ? { data: batch.data + typedSince.data, waiters: [...batch.waiters, ...typedSince.waiters] }
      : { data: batch.data, waiters: batch.waiters };
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
    let sentNow: string | null | undefined;
    try {
      await send(
        batch.data,
        assertActive,
        (instance = null) => {
          sentNow = instance;
        },
        batch.seq,
        batch.sentTo,
      );
      failures = 0;
      batch.waiters.forEach((waiter) => waiter.resolve());
    } catch (error) {
      if (disposed) {
        batch.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
        return;
      }
      if (sentNow !== undefined) batch.sentTo = sentNow;
      if (batch.sentTo === null || needsDecision(error)) {
        held = batch;
        onHold?.({ data: batch.data, error });
        return;
      }
      resending = batch;
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

/**
 * Before a batch is written again: only the gateway instance that already has it can drop the
 * repeat, so anywhere else the user decides.
 */
export function assertSafeResend(sentTo: string | null | undefined, instance: string | null): void {
  if (sentTo !== undefined && sentTo !== instance) throw new TerminalInputNeedsDecisionError();
}

function needsDecision(error: unknown): boolean {
  return (
    error instanceof TerminalInputNeedsDecisionError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'TERMINAL_INPUT_UNCERTAIN')
  );
}

function newStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
