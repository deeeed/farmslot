import { randomUUID } from 'node:crypto';

import type { TerminalInputSequence } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

/**
 * Names this gateway process in `capabilities.terminalInputSequence`. Written numbers live in
 * memory, so a client resends a batch on its own only to the instance that received it.
 */
export const INPUT_SEQUENCE_INSTANCE = randomUUID();

/** Streams remembered per pane; a client opens one per input queue, so a few cover a pane. */
const MAX_STREAMS_PER_PANE = 16;
/** Panes remembered; the least recently typed into is forgotten first. */
const MAX_PANES = 512;
const MAX_STREAM_LENGTH = 64;

interface Written {
  n: number;
  /** The remote write was dispatched and ended without an answer: it may have been typed. */
  uncertain: boolean;
}

const chains = new Map<string, Promise<void>>();
const written = new Map<string, Map<string, Written>>();

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

/**
 * Writes one input batch at most once per sequence number; run it inside `runInputInOrder`.
 * `write` calls `dispatched` just before handing the input to a remote node: a failure after
 * that may still have typed it, so a resend of that number is refused with
 * TERMINAL_INPUT_UNCERTAIN instead of being written again, and the client asks the user.
 */
export async function writeSequencedInput(
  pane: string,
  seq: TerminalInputSequence | undefined,
  write: (dispatched: () => void) => Promise<void> | void,
): Promise<void> {
  if (seq) assertSequence(seq);
  const last = seq ? written.get(pane)?.get(seq.stream) : undefined;
  if (seq && last && seq.n <= last.n) {
    if (seq.n === last.n && last.uncertain)
      throw new GatewayMethodError(
        'TERMINAL_INPUT_UNCERTAIN',
        'This input may already have reached the terminal: its earlier write ended without an answer.',
      );
    return;
  }
  let remote = false;
  try {
    await write(() => {
      remote = true;
    });
  } catch (error) {
    if (seq && remote) remember(pane, seq, true);
    throw error;
  }
  if (seq) remember(pane, seq, false);
}

function assertSequence(seq: TerminalInputSequence): void {
  if (
    typeof seq.stream !== 'string' ||
    seq.stream.length === 0 ||
    seq.stream.length > MAX_STREAM_LENGTH ||
    !Number.isSafeInteger(seq.n) ||
    seq.n < 0
  )
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      `seq needs a stream of 1-${MAX_STREAM_LENGTH} characters and a non-negative integer n.`,
    );
}

function remember(pane: string, seq: TerminalInputSequence, uncertain: boolean): void {
  const streams = written.get(pane) ?? new Map<string, Written>();
  written.delete(pane);
  written.set(pane, streams);
  streams.delete(seq.stream);
  streams.set(seq.stream, { n: seq.n, uncertain });
  if (streams.size > MAX_STREAMS_PER_PANE) dropOldest(streams);
  if (written.size > MAX_PANES) dropOldest(written);
}

function dropOldest(entries: Map<string, unknown>): void {
  const oldest = entries.keys().next();
  if (!oldest.done) entries.delete(oldest.value);
}

export function inputSequenceSizeForTests(): { panes: number; streams: number } {
  let streams = 0;
  for (const pane of written.values()) streams += pane.size;
  return { panes: written.size, streams };
}

export function resetInputSequencesForTests(): void {
  chains.clear();
  written.clear();
}
