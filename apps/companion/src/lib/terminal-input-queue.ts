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
  /** Called after each request that failed before it was sent, before its retry. */
  onRetry?: (error: unknown, attempt: number) => void;
  /** Input is held, or (`null`) no longer held after a resend or discard. */
  onHold?: (held: HeldTerminalInput | null) => void;
  /** Wait before retry `attempt` (0 for the first). */
  retryDelayMs?: (attempt: number) => number;
}

/** Shown once a request has failed twice; cleared when the keys go through. */
export const KEYS_RETRYING_MESSAGE = 'Keys not delivered yet, retrying in order';

const retryBackoffMs = (attempt: number) => Math.min(250 * 2 ** attempt, 4_000);

/**
 * Live input. One request at a time; keys typed while it is on its way share the next one. A
 * keystroke is never dropped without the user deciding:
 * - a request that failed before it was sent (`markSent` not called) is retried, in order, until
 *   it goes out or the queue is disposed (the target or client changed);
 * - a request that failed after it was sent may already be in the pane, and the terminal input
 *   requests carry no id to deduplicate a resend, so it is held: nothing else goes out, keys
 *   typed meanwhile wait behind it, and the user resends or discards it.
 */
export function createTerminalInputQueue(
  send: (data: string, assertActive: () => void, markSent: () => void) => Promise<void>,
  { onRetry, onHold, retryDelayMs = retryBackoffMs }: TerminalInputQueueOptions = {},
): TerminalInputQueue {
  let disposed = false;
  let inFlight = false;
  let pending: InputBatch | null = null;
  let held: InputBatch | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

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

  async function drain(): Promise<void> {
    if (inFlight || retryTimer || held || disposed) return;
    const batch = takePending();
    if (!batch) return;
    inFlight = true;
    let sent = false;
    try {
      await send(batch.data, assertActive, () => {
        sent = true;
      });
      failures = 0;
      batch.waiters.forEach((waiter) => waiter.resolve());
    } catch (error) {
      if (disposed) {
        batch.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
        return;
      }
      if (sent) {
        held = batch;
        onHold?.({ data: batch.data, error });
        return;
      }
      requeueFirst(batch);
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
      if (held) {
        held.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
        held = null;
        onHold?.(null);
      }
      rejectPending(new TerminalInputCancelledError());
    },
  };
}
