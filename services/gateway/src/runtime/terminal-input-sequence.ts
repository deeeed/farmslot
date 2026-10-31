import type { TerminalInputSequence } from '@farmslot/protocol';

/** Streams remembered per pane; a client opens one per input queue, so a few cover a pane. */
const MAX_STREAMS_PER_PANE = 16;
/** Panes remembered; the least recently typed into is forgotten first. */
const MAX_PANES = 512;

const chains = new Map<string, Promise<void>>();
const applied = new Map<string, Map<string, number>>();

/**
 * Runs input for one pane in arrival order. A batch resent after a lost reply therefore waits
 * for the original and sees whether it was written.
 */
export async function runInputInOrder(pane: string, operation: () => Promise<void>): Promise<void> {
  const previous = chains.get(pane) ?? Promise.resolve();
  const current = previous.then(operation);
  // The caller receives its own failure; later input must not inherit that rejection.
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  chains.set(pane, settled);
  try {
    await current;
  } finally {
    if (chains.get(pane) === settled) chains.delete(pane);
  }
}

/** True when this pane already wrote the batch, so a resend is acknowledged without typing it. */
export function inputAlreadyApplied(pane: string, seq: TerminalInputSequence | undefined): boolean {
  if (!seq) return false;
  const last = applied.get(pane)?.get(seq.stream);
  return last !== undefined && seq.n <= last;
}

/** Records a written batch; call only after the write succeeded, so a failed one can be resent. */
export function rememberInputApplied(pane: string, seq: TerminalInputSequence | undefined): void {
  if (!seq) return;
  const streams = applied.get(pane) ?? new Map<string, number>();
  applied.delete(pane);
  applied.set(pane, streams);
  streams.delete(seq.stream);
  streams.set(seq.stream, seq.n);
  if (streams.size > MAX_STREAMS_PER_PANE) dropOldest(streams);
  if (applied.size > MAX_PANES) dropOldest(applied);
}

function dropOldest(entries: Map<string, unknown>): void {
  const oldest = entries.keys().next();
  if (!oldest.done) entries.delete(oldest.value);
}

export function inputSequenceSizeForTests(): { panes: number; streams: number } {
  let streams = 0;
  for (const pane of applied.values()) streams += pane.size;
  return { panes: applied.size, streams };
}

export function resetInputSequencesForTests(): void {
  chains.clear();
  applied.clear();
}
