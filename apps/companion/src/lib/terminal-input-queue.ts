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
  dispose: () => void;
}

export interface TerminalInputQueueOptions {
  /** Called after each failed request, before its retry. */
  onRetry?: (error: unknown, attempt: number) => void;
  /** Wait before retry `attempt` (0 for the first). */
  retryDelayMs?: (attempt: number) => number;
}

/** Shown once a request has failed twice; cleared when the keys go through. */
export const KEYS_RETRYING_MESSAGE = 'Keys not delivered yet, retrying in order';

const retryBackoffMs = (attempt: number) => Math.min(250 * 2 ** attempt, 4_000);

/**
 * Live input. One request at a time; keys typed while it is on its way share the next one. A
 * keystroke is never dropped: a failed request keeps its keys ahead of the ones typed since and is
 * retried, in order, until it goes through or the queue is disposed (the target or client
 * changed). A retry after a lost reply can repeat keys the pane already has, which shows; a
 * dropped key would not.
 */
export function createTerminalInputQueue(
  send: (data: string, assertActive: () => void) => Promise<void>,
  { onRetry, retryDelayMs = retryBackoffMs }: TerminalInputQueueOptions = {},
): TerminalInputQueue {
  let disposed = false;
  let inFlight = false;
  let pending: InputBatch | null = null;
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

  function rejectPending(error: unknown) {
    takePending()?.waiters.forEach((waiter) => waiter.reject(error));
  }

  async function drain(): Promise<void> {
    if (inFlight || retryTimer || disposed) return;
    const batch = takePending();
    if (!batch) return;
    inFlight = true;
    try {
      await send(batch.data, assertActive);
      failures = 0;
      batch.waiters.forEach((waiter) => waiter.resolve());
    } catch (error) {
      if (disposed) {
        batch.waiters.forEach((waiter) => waiter.reject(new TerminalInputCancelledError()));
        return;
      }
      // Keys typed since go after the failed ones.
      const typedSince = takePending();
      pending = typedSince
        ? { data: batch.data + typedSince.data, waiters: [...batch.waiters, ...typedSince.waiters] }
        : batch;
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
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      rejectPending(new TerminalInputCancelledError());
    },
  };
}
