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

/** A gateway's terminal input numbering. */
export interface TerminalInputSequencing {
  instance: string;
  /** The pane keeps the record, so any instance drops a repeat; otherwise only `instance`. */
  durable: boolean;
}

/** Where a batch whose frame was written may be sent again. */
export type TerminalInputResend = 'anywhere' | 'nowhere' | { onlyTo: string };

export function inputSequenceOf(
  capability: { instance: string; durable?: boolean } | undefined,
): TerminalInputSequencing | null {
  return capability
    ? { instance: capability.instance, durable: capability.durable === true }
    : null;
}

/** What a batch written to a gateway with `sequencing` allows on a later attempt. */
export function resendScope(sequencing: TerminalInputSequencing | null): TerminalInputResend {
  if (!sequencing) return 'nowhere';
  return sequencing.durable ? 'anywhere' : { onlyTo: sequencing.instance };
}

/**
 * Before a batch is written again: only a gateway with durable records drops a repeat whichever
 * instance took the batch. One from before pane records (#1667) keeps them in its process, so
 * only that instance can; one without numbering cannot at all.
 */
export function assertResendable(
  sentTo: TerminalInputResend | undefined,
  sequencing: TerminalInputSequencing | null,
): void {
  const dropsRepeat =
    sentTo === undefined ||
    (sentTo === 'anywhere' && sequencing?.durable === true) ||
    (typeof sentTo === 'object' && sequencing?.instance === sentTo.onlyTo);
  if (!dropsRepeat) throw new TerminalInputMaybeTypedError(new Error('the gateway restarted'));
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
  /** Where an attempt that reached the gateway allows it to go again. */
  sentTo?: TerminalInputResend;
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
 * since: a gateway that numbers input durably (`markSent('anywhere')`) types each number once,
 * even across its restarts. A keystroke is never typed twice on its own: a batch written to a
 * gateway without numbering (`markSent('nowhere')`), one bound for another instance than the one
 * that took it (`assertResendable`), or one answered TERMINAL_INPUT_UNCERTAIN by a gateway whose
 * node predates numbering, is dropped with TerminalInputMaybeTypedError and the queue moves on.
 * A malformed request (INVALID_PARAMS) is dropped with its error.
 */
export function createTerminalInputQueue(
  send: (
    data: string,
    assertActive: () => void,
    markSent: (resend: TerminalInputResend) => void,
    seq: TerminalInputSequence,
    sentTo: TerminalInputResend | undefined,
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
    let sent: TerminalInputResend | undefined;
    try {
      await send(
        batch.data,
        assertActive,
        (resend) => {
          sent = resend;
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
      if (sent !== undefined) batch.sentTo = sent;
      const code = gatewayCode(error);
      if (
        batch.sentTo === 'nowhere' ||
        code === 'TERMINAL_INPUT_UNCERTAIN' ||
        code === 'INVALID_PARAMS' ||
        error instanceof TerminalInputMaybeTypedError
      ) {
        const dropped =
          code === 'INVALID_PARAMS' || error instanceof TerminalInputMaybeTypedError
            ? error
            : new TerminalInputMaybeTypedError(error);
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
        retryDelayMs(failures++, sent !== undefined && Boolean(code)),
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

function gatewayCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code || '') || undefined
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
