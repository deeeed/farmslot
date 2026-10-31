import type { TerminalInputSequence } from '@farmslot/protocol';

export class TerminalInputCancelledError extends Error {
  constructor() {
    super('Terminal input cancelled because the connection or target changed');
    this.name = 'TerminalInputCancelledError';
  }
}

/**
 * Keys that may already be in the pane and cannot be sent again without risking typing them
 * twice: written to a gateway that does not number input, or refused as uncertain by one whose
 * node predates numbered input.
 */
export class TerminalInputMaybeTypedError extends Error {
  constructor(cause: unknown) {
    super(
      `Keys may have reached the terminal and were not sent again (${errorText(cause)}); check it before typing them again`,
    );
    this.name = 'TerminalInputMaybeTypedError';
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
  dispose: () => void;
}

/** A terminal's input: `write` queues keys. */
export interface TerminalInput {
  write: (data: string) => Promise<void>;
}

export interface TerminalInputQueueOptions {
  /** Called after each failed request, before its retry. */
  onRetry?: (error: unknown, attempt: number) => void;
  /** Wait before retry `attempt` (0 for the first); `answered`: the gateway answered an error. */
  retryDelayMs?: (attempt: number, answered: boolean) => number;
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

/** A gateway's error answer (a refusal, a pane not ready) waits longer than a lost connection. */
export const terminalInputRetryDelayMs = (attempt: number, answered: boolean) =>
  Math.min(250 * 2 ** attempt, answered ? 30_000 : 4_000);

/**
 * Live input. One request at a time; keys typed while it is on its way share the next one, and
 * each batch is numbered in this queue's stream. Once numbered, a batch's keys never change: keys
 * typed later form the next batch. A failed batch is sent again, as is, ahead of anything typed
 * since: a gateway that numbers input (`markSent(true)`) types each number once, even across its
 * restarts. A keystroke is never typed twice on its own: a batch written to a gateway without
 * numbering (`markSent(false)`), or answered TERMINAL_INPUT_UNCERTAIN by one whose node predates
 * it, is dropped with TerminalInputMaybeTypedError and the queue moves on.
 */
export function createTerminalInputQueue(
  send: (
    data: string,
    assertActive: () => void,
    markSent: (typesOnce: boolean) => void,
    seq: TerminalInputSequence,
  ) => Promise<void>,
  {
    onRetry,
    retryDelayMs = terminalInputRetryDelayMs,
    stream = newStreamId(),
  }: TerminalInputQueueOptions = {},
): TerminalInputQueue {
  let disposed = false;
  let inFlight = false;
  let pending: InputBatch | null = null;
  let resending: NumberedBatch | null = null;
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
    if (inFlight || retryTimer || disposed) return;
    const batch = nextBatch();
    if (!batch) return;
    inFlight = true;
    let sent: boolean | undefined;
    try {
      await send(
        batch.data,
        assertActive,
        (typesOnce) => {
          sent = typesOnce;
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
      if (sent === false || isUncertain(error)) {
        const dropped = new TerminalInputMaybeTypedError(error);
        batch.waiters.forEach((waiter) => waiter.reject(dropped));
        failures = 0;
        return;
      }
      resending = batch;
      onRetry?.(error, failures);
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          void drain();
        },
        retryDelayMs(failures++, sent === true && hasGatewayCode(error)),
      );
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
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      resending?.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
      resending = null;
      takePending()?.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
    },
  };
}

function hasGatewayCode(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && Boolean(error.code);
}

function isUncertain(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'TERMINAL_INPUT_UNCERTAIN'
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
