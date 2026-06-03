// active-run-selection.ts — single source of truth for "which active run owns this slot?"
//
// Three modules previously inlined near-identical sort+filter logic with
// subtly different policies (agent-contexts threw on ambiguity, methods/run
// warned and returned null, task-watcher warned and returned a skip-sentinel).
// This helper centralizes the selection logic and parameterizes the policy so
// every callsite reuses the same sort + match rules and divergence is limited
// to a single options object.

import type { Run } from '@farmslot/protocol';

export type AmbiguityPolicy = 'throw' | 'warn-null' | 'warn-skip';
export type MissingPointerPolicy = AmbiguityPolicy | 'fallback';

/**
 * Returned by selection helpers when the caller asked for `warn-skip` and the
 * selection cannot be made. Distinct from `null` (which means "no active run
 * for this slot") so event-loop callers can tell "skip this iteration" apart
 * from "no run, fall back to bare session view".
 */
export const SKIP_ACTIVE_RUN_SELECTION = Symbol('skip-active-run-selection');
export type ActiveRunSelectionResult = Run | null | typeof SKIP_ACTIVE_RUN_SELECTION;

// Internal sentinel: tells the caller "the pointer policy chose to fall back;
// keep going with the slotId-only candidate scan." A symbol so it cannot
// collide with a Run id, even hypothetically.
const FALLBACK_TO_SCAN: unique symbol = Symbol('fallback-to-scan');
type FallbackToScan = typeof FALLBACK_TO_SCAN;
const isFallback = (value: ActiveRunSelectionResult | FallbackToScan): value is FallbackToScan =>
  value === FALLBACK_TO_SCAN;

export interface ActiveRunSelectionOptions {
  /** Highest-priority pointer set by the caller (e.g. dispatch-supplied runId). */
  requestedRunId?: string | null;
  /** The slot's own current_run_id pointer (from fleet status). */
  currentRunId?: string | null;
  /** Behavior when multiple active runs match the slot and no pointer disambiguates. */
  onAmbiguous: AmbiguityPolicy;
  /**
   * Behavior when a provided pointer points to a missing or wrong-slot run.
   * `'fallback'` ignores the pointer and runs the slotId-only filter (which
   * may then trigger `onAmbiguous`). Defaults to `'warn-null'`.
   */
  onMissingPointer?: MissingPointerPolicy;
  /** Log prefix used in warnings/errors (e.g. `'[agent-contexts]'`). */
  logPrefix?: string;
}

/**
 * Pick the single active Run for `slotId` from `activeRuns` according to the
 * supplied policy options. Caller is responsible for filtering `activeRuns`
 * to the active subset before calling — the helper assumes they are all
 * non-terminal.
 */
export function selectSingleActiveRunForSlot(
  slotId: string,
  activeRuns: ReadonlyArray<Run>,
  options: ActiveRunSelectionOptions,
): ActiveRunSelectionResult {
  const onMissing: MissingPointerPolicy = options.onMissingPointer ?? 'warn-null';
  const tag = options.logPrefix ?? '[active-run-selection]';

  const reportPointer = (msg: string): ActiveRunSelectionResult | FallbackToScan => {
    const fullMsg = `${tag} ${msg}`;
    switch (onMissing) {
      case 'throw':
        throw new Error(fullMsg);
      case 'warn-null':
        console.warn(fullMsg);
        return null;
      case 'warn-skip':
        console.warn(fullMsg);
        return SKIP_ACTIVE_RUN_SELECTION;
      case 'fallback':
        return FALLBACK_TO_SCAN;
      default: {
        const _exhaustive: never = onMissing;
        throw new Error(`Unhandled MissingPointerPolicy: ${String(_exhaustive)}`);
      }
    }
  };

  if (options.requestedRunId) {
    const requested = activeRuns.find((r) => r.id === options.requestedRunId);
    if (!requested) {
      const handled = reportPointer(
        `requested runId ${options.requestedRunId} is not active for slot ${slotId}`,
      );
      if (!isFallback(handled)) return handled;
    } else if (requested.slotId !== slotId) {
      const handled = reportPointer(
        `requested runId ${options.requestedRunId} belongs to slot ${requested.slotId ?? '-'}, not ${slotId}`,
      );
      if (!isFallback(handled)) return handled;
    } else {
      return requested;
    }
  } else if (options.currentRunId) {
    const current = activeRuns.find((r) => r.id === options.currentRunId);
    if (!current) {
      const handled = reportPointer(
        `currentRunId ${options.currentRunId} is not in the active list for slot ${slotId}`,
      );
      if (!isFallback(handled)) return handled;
    } else if (current.slotId !== slotId) {
      const handled = reportPointer(
        `currentRunId ${options.currentRunId} belongs to slot ${current.slotId ?? '-'}, not ${slotId}`,
      );
      if (!isFallback(handled)) return handled;
    } else {
      return current;
    }
  }

  const candidates = sortActiveRunsNewestFirst(activeRuns.filter((r) => r.slotId === slotId));
  if (candidates.length > 1) {
    const msg = `multiple active runs for slot ${slotId} without currentRunId — refusing to guess (runs: ${candidates.map((r) => `${r.id.slice(0, 8)}@${r.createdAt}`).join(', ')})`;
    const fullMsg = `${tag} ${msg}`;
    switch (options.onAmbiguous) {
      case 'throw':
        throw new Error(fullMsg);
      case 'warn-null':
        console.warn(fullMsg);
        return null;
      case 'warn-skip':
        console.warn(fullMsg);
        return SKIP_ACTIVE_RUN_SELECTION;
      default: {
        const _exhaustive: never = options.onAmbiguous;
        throw new Error(`Unhandled AmbiguityPolicy: ${String(_exhaustive)}`);
      }
    }
  }
  return candidates[0] ?? null;
}

/**
 * Stable sort: newest createdAt first, ties broken by updatedAt then id.
 * Exported so callers that need a sorted view (e.g. UI lists) reuse the same
 * ordering as the selection helper.
 */
export function sortActiveRunsNewestFirst<
  T extends { createdAt: string; updatedAt: string; id: string },
>(runs: ReadonlyArray<T>): T[] {
  return [...runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      b.id.localeCompare(a.id),
  );
}
