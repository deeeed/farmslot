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

/** Live input only. Pending keys share one next request and are never retried. */
export function createTerminalInputQueue(
  send: (data: string) => Promise<void>,
): TerminalInputQueue {
  let disposed = false;
  let inFlight = false;
  let pending: InputBatch | null = null;

  function rejectPending(error: unknown) {
    const batch = pending;
    pending = null;
    batch?.waiters.forEach((waiter) => waiter.reject(error));
  }

  async function drain(): Promise<void> {
    if (inFlight || disposed || !pending) return;
    const batch = pending;
    pending = null;
    inFlight = true;
    try {
      await send(batch.data);
      batch.waiters.forEach((waiter) => waiter.resolve());
    } catch (error) {
      batch.waiters.forEach((waiter) => waiter.reject(error));
      // Delivery is unknown after an error. Drop buffered keys instead of replaying them.
      rejectPending(error);
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
      rejectPending(new TerminalInputCancelledError());
    },
  };
}
