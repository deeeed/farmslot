// owned-worker-idle-wait.ts — Bounded wait for an owned worker that is still making progress.

import { isGateParkInFlightOrFreed, OWNED_WORKER_IDLE_WAIT_MS } from '@farmslot/protocol';

import { readRunProgress } from '../runners/run-progress.js';
import { getRun } from '../runs/store.js';

import { runSupersededSince } from './run-generation.js';

export interface OwnedWorkerIdleWaitBounds {
  pollMs: number;
  maxPollMs: number;
  timeoutMs: number;
  /** How often a cancellable wait checks its caller between progress reads. */
  cancelCheckMs?: number;
}

// A compaction or a last turn finishes in minutes; past this the caller sees why. Polls back off
// (10 s, 20 s, 40 s, then every 60 s): each reads the worker's transcript state.
export const OWNED_WORKER_IDLE_WAIT: OwnedWorkerIdleWaitBounds = {
  pollMs: 10_000,
  maxPollMs: 60_000,
  timeoutMs: OWNED_WORKER_IDLE_WAIT_MS,
};

export interface OwnedWorkerIdleWaitOptions {
  readProgress?: typeof readRunProgress;
  /** Tests shorten it. */
  bounds?: OwnedWorkerIdleWaitBounds;
  /** True once whoever asked for the work is gone; the wait then ends as `abort`. */
  cancelled?: () => boolean;
}

function pause(ms: number, cancelled: (() => boolean) | undefined, checkMs: number): Promise<void> {
  if (!cancelled) return new Promise((resolve) => setTimeout(resolve, ms));
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0 || cancelled()) resolve();
      else setTimeout(tick, Math.min(left, checkMs));
    };
    tick();
  });
}

/**
 * Waits for an owned worker that is making progress to go idle. A worker that cannot go idle by
 * itself (at a prompt, pane unproven) ends the wait at once as `timeout`, and a gate park as
 * `parked`; a replay, pause or cancel of the run, or a cancelled caller, ends it as `abort`.
 */
export async function waitForOwnedWorkerIdle(
  runId: string,
  generation: number,
  options: OwnedWorkerIdleWaitOptions = {},
): Promise<'idle' | 'abort' | 'timeout' | 'parked'> {
  const {
    pollMs,
    maxPollMs,
    timeoutMs,
    cancelCheckMs = 1_000,
  } = options.bounds ?? OWNED_WORKER_IDLE_WAIT;
  const readProgress = options.readProgress ?? readRunProgress;
  const stopped = () =>
    Boolean(options.cancelled?.()) || runSupersededSince(getRun(runId), generation);
  const deadline = Date.now() + timeoutMs;
  for (let delay = pollMs; Date.now() < deadline; delay = Math.min(delay * 2, maxPollMs)) {
    await pause(Math.min(delay, deadline - Date.now()), options.cancelled, cancelCheckMs);
    if (stopped()) return 'abort';
    const before = getRun(runId)!;
    if (isGateParkInFlightOrFreed(before)) return 'parked';
    const progress = await readProgress(before);
    // The probe awaited a remote read: an operator may have replayed or cancelled meanwhile.
    if (stopped()) return 'abort';
    if (progress.kind === 'idle') return 'idle';
    if (progress.kind !== 'making-progress') return 'timeout';
  }
  return 'timeout';
}
