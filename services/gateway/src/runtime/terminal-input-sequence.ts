import { randomUUID } from 'node:crypto';

import {
  formatTerminalInputRecord,
  isTerminalInputStream,
  parseTerminalInputRecord,
  staleTerminalInputRecords,
  terminalInputRecordOption,
  type TerminalInputSequence,
} from '@farmslot/protocol';

import type { ExecResult } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';

/**
 * Names this gateway process in `capabilities.terminalInputSequence`. Clients from before pane
 * records resend a batch on their own only to the instance that received it.
 */
export const INPUT_SEQUENCE_INSTANCE = randomUUID();

/** Streams remembered per pane; a client opens one per input queue, so a few cover a pane. */
const MAX_STREAMS_PER_PANE = 16;
/** Panes remembered; the least recently typed into is forgotten first. */
const MAX_PANES = 512;

interface Written {
  n: number;
  /** The remote write was dispatched and ended without an answer: it may have been typed. */
  uncertain: boolean;
}

/** Where a batch is typed. */
export interface InputLanding {
  /** Types the keys; calls `dispatched` just before handing them to another host. */
  write: (dispatched: () => void) => Promise<void> | void;
  /** That host types each (pane, stream, n) once, so a write that may have typed is resent. */
  typesOnce?: boolean;
  /** The pane's own record of typed batches, which outlives this process. */
  record?: PaneInputRecord;
}

export interface PaneInputRecord {
  /** The last batch of `stream` typed into the pane, or null when none is recorded. */
  read: (stream: string) => Promise<number | null>;
  /** Records `seq` once its keys are in the pane. */
  write: (seq: TerminalInputSequence) => Promise<void>;
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
 * Numbers written by this process are remembered here. When this process knows nothing of the
 * stream (a restart) or its last write ended without an answer, the pane's record decides; a
 * landing that types each number once is simply sent the batch again. Only a remote write with
 * neither (a node predating `terminalInputSequence`) is refused with TERMINAL_INPUT_UNCERTAIN.
 */
export async function writeSequencedInput(
  pane: string,
  seq: TerminalInputSequence | undefined,
  landing: InputLanding,
): Promise<void> {
  if (!seq) {
    await landing.write(() => undefined);
    return;
  }
  assertSequence(seq);
  const last = written.get(pane)?.get(seq.stream);
  if (landing.record && (!last || (last.uncertain && seq.n === last.n))) {
    const recorded = await readRecord(landing.record, pane, seq.stream);
    if (recorded !== null && recorded >= seq.n) {
      remember(pane, { stream: seq.stream, n: recorded }, false);
      return;
    }
  } else if (last && seq.n <= last.n) {
    if (seq.n < last.n || !last.uncertain) return;
    if (!landing.typesOnce)
      throw new GatewayMethodError(
        'TERMINAL_INPUT_UNCERTAIN',
        'This input may already have reached the terminal: its earlier write ended without an answer.',
      );
  }
  let remote = false;
  try {
    await landing.write(() => {
      remote = true;
    });
  } catch (error) {
    if (remote) remember(pane, seq, true);
    throw error;
  }
  remember(pane, seq, false);
  // A restart between the write above and this record forgets the batch.
  await landing.record?.write(seq).catch((error: unknown) => {
    // The keys are in the pane: an error answer would only get them typed again.
    console.warn(
      `[terminal-input] ${pane}: typed but not recorded on the pane: ${errorText(error)}`,
    );
  });
}

async function readRecord(
  record: PaneInputRecord,
  pane: string,
  stream: string,
): Promise<number | null> {
  try {
    return await record.read(stream);
  } catch (error) {
    console.warn(`[terminal-input] ${pane}: pane record unreadable, writing: ${errorText(error)}`);
    return null;
  }
}

/**
 * The record of tmux pane `target`, read and written by `run` on the pane's host (a shell
 * command line, as `execOnSlot` takes).
 */
export function tmuxPaneInputRecord(
  target: string,
  run: (command: string) => Promise<ExecResult>,
): PaneInputRecord {
  const pane = shellQuote(target);
  const tmux = async (command: string) => {
    const result = await run(tmuxShellSnippet(command));
    if (result.exitCode !== 0)
      throw new Error(`tmux failed: ${result.stderr?.trim() || `exit ${result.exitCode}`}`);
    return result.stdout;
  };
  return {
    read: async (stream) =>
      parseTerminalInputRecord(
        await tmux(`show-options -pqv -t ${pane} ${shellQuote(terminalInputRecordOption(stream))}`),
      ),
    write: async ({ stream, n }) => {
      const option = shellQuote(terminalInputRecordOption(stream));
      const value = shellQuote(formatTerminalInputRecord(n, Date.now()));
      const options = await tmux(
        `set-option -p -t ${pane} ${option} ${value} && "$TMUX_BIN" show-options -p -t ${pane}`,
      );
      for (const stale of staleTerminalInputRecords(options))
        await tmux(`set-option -p -u -t ${pane} ${shellQuote(stale)}`);
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSequence(seq: TerminalInputSequence): void {
  if (!isTerminalInputStream(seq.stream) || !Number.isSafeInteger(seq.n) || seq.n < 0)
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      'seq needs a stream of 1-64 letters, digits, _ or - and a non-negative integer n.',
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
