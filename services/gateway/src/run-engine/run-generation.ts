// run-generation.ts — Leaf module (no engine imports) so step owners and the
// orchestrator can share it without an import cycle.

import type { Run } from '@farmslot/protocol';

/**
 * Whether the engine attempt that started at `generation` no longer owns the
 * run: the run is gone, an operator cancelled or paused it, or a replay or
 * resume started a new generation. That attempt must stop without writing
 * (slot claims included), and its late exception must not overwrite the
 * operator's state.
 */
export function runSupersededSince(
  run: Pick<Run, 'status' | 'engineState'> | undefined,
  generation: number,
): boolean {
  return (
    !run ||
    run.status === 'cancelled' ||
    run.status === 'paused' ||
    (run.engineState?.generation ?? 0) !== generation
  );
}
