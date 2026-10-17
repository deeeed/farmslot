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

export interface RereadOptions<T> {
  /**
   * What of the value stays on screen when a new target starts, for facts the targets share
   * (for example a run's recipe-run list across recipe-run selections). Default: nothing.
   */
  keepOnReset?: (value: T) => T;
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
  options: RereadOptions<T> = {},
): Reread<T> {
  const [state, setState] = useState<RereadState<T>>(EMPTY);
  const request = useRef(0);
  const describeRef = useRef(describe);
  describeRef.current = describe;
  const keepOnResetRef = useRef(options.keepOnReset);
  keepOnResetRef.current = options.keepOnReset;

  useEffect(() => {
    if (read) return;
    request.current += 1;
    setState(EMPTY);
  }, [read]);

  const refresh = useCallback(
    async (reason: string, reset: boolean) => {
      const id = ++request.current;
      if (!read) return;
      if (reset)
        setState((current) => {
          const keep = keepOnResetRef.current;
          return { ...EMPTY, value: keep && current.value !== null ? keep(current.value) : null };
        });
      try {
        const value = await read();
        if (request.current === id) setState({ value, error: null, settled: true });
      } catch (error) {
        if (request.current !== id) return;
        const message = error instanceof Error ? error.message : String(error);
        if (isGatewayBackgroundPauseError(error)) {
          console.warn(
            `${describeRef.current(reason, message)} (paused; the next connection re-reads)`,
          );
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
