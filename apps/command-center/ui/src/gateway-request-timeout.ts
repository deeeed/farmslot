import {
  Events,
  FILE_TRANSFER_IDLE_TIMEOUT_MS,
  type FileTransferProgress,
} from '@farmslot/protocol';
import type { ResourceReadOptions } from '@farmslot/protocol/client-cache';

export interface GatewayRequestOptions extends ResourceReadOptions {
  /** null waits for the server response or disconnection, including a slow mutation. */
  timeout?: number | null;
  /** Reset the idle timer when this gateway event arrives. */
  extendOnEvent?: string;
  extendWhen?: (payload: unknown) => boolean;
}

/** The gateway did not answer in time; the request may still have taken effect there. */
export class GatewayRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRequestTimeoutError';
  }
}

/**
 * Resolving a decision revalidates the gate against its slot before the gateway
 * answers, and may restore a parked gate first. The client waits for that answer
 * (a refusal included) rather than guessing, and says it is still waiting after
 * `DECISION_RESOLVE_SLOW_MS`.
 */
export const DECISION_RESOLVE_TIMEOUT_MS = 600_000;
export const DECISION_RESOLVE_SLOW_MS = 15_000;

export interface IdleRequestTimeoutHandle {
  clear(): void;
  extend(): void;
}

/** Idle timer that restarts on `extend()` and never fires after `clear()`. */
export function createIdleRequestTimeout(options: {
  timeoutMs: number | null;
  onTimeout: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}): IdleRequestTimeoutHandle {
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((id: unknown) => {
      clearTimeout(id as ReturnType<typeof setTimeout>);
    });
  let timer: unknown;
  let cleared = false;

  const arm = () => {
    if (cleared || options.timeoutMs === null) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      if (cleared) return;
      cleared = true;
      options.onTimeout();
    }, options.timeoutMs);
  };

  arm();
  return {
    extend() {
      if (!cleared) arm();
    },
    clear() {
      cleared = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}

export function transferProgressExtendsRequest(runId: string, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const progress = payload as Partial<FileTransferProgress>;
  return progress.runId === runId && progress.state === 'running';
}

/**
 * Idle RPC window for methods that copy slot artifacts while `file.transfer.progress` is live.
 * The UI uses the fixed base window because each matching progress event restarts it; the gateway
 * separately scales its transport timeout from the known transfer size.
 */
export function transferBoundRequestOptions(runId: string): GatewayRequestOptions {
  return {
    timeout: FILE_TRANSFER_IDLE_TIMEOUT_MS,
    extendOnEvent: Events.FILE_TRANSFER_PROGRESS,
    extendWhen: (payload) => transferProgressExtendsRequest(runId, payload),
  };
}

export function normalizeGatewayRequestOptions(
  timeoutOrOptions: number | GatewayRequestOptions | undefined,
  defaultTimeoutMs: number,
): Required<Pick<GatewayRequestOptions, 'timeout'>> & GatewayRequestOptions {
  if (typeof timeoutOrOptions === 'number') return { timeout: timeoutOrOptions };
  return { timeout: defaultTimeoutMs, ...timeoutOrOptions };
}
