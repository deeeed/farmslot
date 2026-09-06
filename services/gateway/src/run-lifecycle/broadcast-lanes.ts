/**
 * The run-settlement lane, as a composable wrapper (ADR-053).
 *
 * Two broadcasters exist on purpose. Both reach every client and every
 * observer; only one of them ALSO kicks off backlog settlement and a scheduler
 * tick from the event itself.
 *
 * The transition router settles those aggregates itself — awaited, ordered, and
 * with a durable repair marker when the settle fails. A router-owned terminal
 * publish that went out on the lane below started a second, unordered copy of
 * that same work: the scheduler could tick against a projection whose
 * persistence was still in flight, or had already failed, which is precisely
 * the ordering the router exists to impose. Publishes the router does NOT own —
 * every step transition, every non-terminal update, and the terminal paths that
 * still bypass the router — keep the lane, because for those it is the only
 * thing that settles them at all.
 *
 * Extracted from the wiring so the distinction is testable rather than a shape
 * two closures in `index.ts` happen to have.
 */
import { Events, type Run } from '@farmslot/protocol';

export type BroadcastFn = (event: string, payload: unknown) => void;

/** Events that carry a run whose settlement this lane is responsible for. */
function runFromSettlementEvent(event: string, payload: unknown): Run | undefined {
  if (event !== Events.RUN_UPDATED && event !== Events.RUN_COMPLETED) return undefined;
  return (payload as { run?: Run }).run;
}

/**
 * Wrap `base` so run events also drive backlog settlement and a scheduler tick.
 *
 * `settle` owns its own failure handling: this lane is fire-and-forget by
 * design, and swallowing the rejection here would hide a settle that never
 * landed.
 */
export function withRunSettlementLane(base: BroadcastFn, settle: (run: Run) => void): BroadcastFn {
  return (event, payload) => {
    base(event, payload);
    const run = runFromSettlementEvent(event, payload);
    if (run) settle(run);
  };
}
