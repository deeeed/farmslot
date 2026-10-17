import { useCallback, useEffect, useRef, useState } from 'react';

import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';

export interface RereadState<T> {
  /** The last successful result for the current target; null before one arrives. */
  value: T | null;
  /** Why this read last failed; cleared by its next success. */
  error: string | null;
  /** A read for the current target has finished, successfully or not. */
  settled: boolean;
}

export interface Reread<T> extends RereadState<T> {
  /** `reset` starts the target fresh (see connected-refresh); otherwise the value stays on screen. */
  refresh: (reason: string, reset: boolean) => Promise<void>;
}

const EMPTY = { value: null, error: null, settled: false } as const;

/**
 * One gateway read a screen repeats on reconnects, run events and refreshes. A success
 * replaces the value and clears this read's error, so another read's error is untouched. A
 * failure keeps the value on screen: a background pause stays quiet, since the next connection
 * re-reads, and any other failure is reported until the next success. Only the latest request
 * lands. `read` must be stable and change only with its target; null means there is none.
 */
export function useReread<T>(
  read: (() => Promise<T>) | null,
  describe: (reason: string, message: string) => string,
): Reread<T> {
  const [state, setState] = useState<RereadState<T>>(EMPTY);
  const request = useRef(0);
  const describeRef = useRef(describe);
  describeRef.current = describe;

  useEffect(() => {
    if (read) return;
    request.current += 1;
    setState(EMPTY);
  }, [read]);

  const refresh = useCallback(
    async (reason: string, reset: boolean) => {
      const id = ++request.current;
      if (!read) return;
      if (reset) setState(EMPTY);
      try {
        const value = await read();
        if (request.current === id) setState({ value, error: null, settled: true });
      } catch (error) {
        if (request.current !== id) return;
        const message = error instanceof Error ? error.message : String(error);
        if (isGatewayBackgroundPauseError(error)) {
          console.warn(`Read paused after ${reason}: ${message}`);
          setState((current) => ({ ...current, settled: true }));
          return;
        }
        setState((current) => ({
          value: current.value,
          error: describeRef.current(reason, message),
          settled: true,
        }));
      }
    },
    [read],
  );

  return { ...state, refresh };
}
