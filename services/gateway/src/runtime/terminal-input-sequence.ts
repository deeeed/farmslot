import { randomUUID } from 'node:crypto';

import {
  formatTerminalInputRecord,
  isTerminalInputStream,
  parseTerminalInputRecord,
  TERMINAL_INPUT_RECORD_PREFIX,
  TERMINAL_INPUT_RECORD_STREAMS,
  terminalInputRecordOption,
  type TerminalInputSequence,
} from '@farmslot/protocol';

import { execLocal, type ExecResult } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import { nodeExec } from '../fleet/node-rpc.js';

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
  /** That write records the batch on the pane with its keys, so the pane record decides. */
  recordedWithKeys?: boolean;
}

/** Where a batch is typed. */
export interface InputLanding {
  /** Types the keys; calls `dispatched` just before handing them to another host. */
  write: (dispatched: () => void, seq?: TerminalInputSequence) => Promise<void> | void;
  /** That host types each (pane, stream, n) once, so a write that may have typed is resent. */
  typesOnce?: boolean;
  /** The pane's own record of typed batches, which outlives this process. */
  record?: PaneInputRecord;
  /** `write` records `seq` on the pane in the same command that types it. */
  recordsOnWrite?: boolean;
}

export interface PaneInputRecord {
  /** The last batch of `stream` typed into the pane, or null when none is recorded; throws when unreadable. */
  read: (stream: string) => Promise<number | null>;
  /** Records `seq` once its keys are in the pane. */
  write: (seq: TerminalInputSequence) => Promise<void>;
}

const chains = new Map<string, Promise<void>>();
const written = new Map<string, Map<string, Written>>();
/** Pane record writes still on their way, in order per pane. */
const recording = new Map<string, Promise<void>>();

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
 * Numbers written by this process are remembered here, so a known repeat is acknowledged before
 * `landing` is resolved. When this process knows nothing of the stream (a restart) or its last
 * write ended without an answer, the pane's record decides; a landing that types each number once
 * is simply sent the batch again. Only a remote write with neither (a node predating
 * `terminalInputSequence`) is refused with TERMINAL_INPUT_UNCERTAIN. A record that cannot be read
 * fails the batch untyped, for the client to retry.
 */
export async function writeSequencedInput(
  pane: string,
  seq: TerminalInputSequence | undefined,
  landing: InputLanding | (() => Promise<InputLanding>),
): Promise<void> {
  const resolve = async () => (typeof landing === 'function' ? landing() : landing);
  if (!seq) {
    await (await resolve()).write(() => undefined);
    return;
  }
  assertSequence(seq);
  const last = written.get(pane)?.get(seq.stream);
  const unsure = !last || (last.uncertain && seq.n === last.n);
  if (last && seq.n <= last.n && !unsure) return;
  // A write that may have typed without recording it: nothing can tell, so it is not sent again.
  if (unsure && last?.uncertain && !last.recordedWithKeys) throw uncertain();
  const target = await resolve();
  const record = target.record;
  if (unsure && record) {
    await recording.get(pane);
    const recorded = await record.read(seq.stream);
    if (recorded !== null && recorded >= seq.n) {
      remember(pane, { stream: seq.stream, n: recorded }, false);
      return;
    }
  } else if (unsure && last && !target.typesOnce) {
    throw uncertain();
  }
  // A write that records on the pane itself (slot send-keys, a node) must not be overtaken by
  // an earlier batch's record still on its way, which would lower the record.
  if (target.recordsOnWrite || target.typesOnce) await recording.get(pane);
  let remote = false;
  try {
    await target.write(() => {
      remote = true;
    }, seq);
  } catch (error) {
    if (remote) remember(pane, seq, true, Boolean(target.recordsOnWrite || target.typesOnce));
    throw error;
  }
  remember(pane, seq, false);
  if (record && !target.recordsOnWrite) recordInOrder(pane, record, seq);
}

function uncertain(): GatewayMethodError {
  return new GatewayMethodError(
    'TERMINAL_INPUT_UNCERTAIN',
    'This input may already have reached the terminal: its earlier write ended without an answer.',
  );
}

/**
 * tmux before 3.0 keeps no pane options, so no batch typed there is ever recorded: numbered input
 * is refused rather than typed again after a restart.
 */
function recordsUnsupported(message = 'Needs tmux 3.0 or later on this host'): GatewayMethodError {
  return new GatewayMethodError('TERMINAL_INPUT_UNSUPPORTED', message);
}

/**
 * For a pane typed through a node that keeps no record (one predating `terminalInputSequence`,
 * or on tmux before 3.0): a batch this process has no memory of may be a resend after a restart,
 * so it is refused; batches after one this process typed go through.
 */
export const UNRECORDED_PANE: PaneInputRecord = {
  read: async () => {
    throw recordsUnsupported('Needs an updated node with tmux 3.0 or later');
  },
  write: async () => {},
};

/**
 * Records a batch on its pane without holding up the reply: a client resends only when the reply
 * is lost, and this process remembers the batch meanwhile. A restart before the record lands
 * forgets that batch.
 */
function recordInOrder(pane: string, record: PaneInputRecord, seq: TerminalInputSequence): void {
  const current = (recording.get(pane) ?? Promise.resolve())
    .then(() => record.write(seq))
    .catch((error: unknown) => {
      // The keys are in the pane: failing the batch would only get them typed again.
      console.warn(
        `[terminal-input] ${pane}: typed but not recorded on the pane: ${errorText(error)}`,
      );
    });
  recording.set(pane, current);
  void current.then(() => {
    if (recording.get(pane) === current) recording.delete(pane);
  });
}

export async function inputRecordsSettledForTests(): Promise<void> {
  await Promise.all(recording.values());
}

/**
 * tmux arguments, to follow `"$TMUX_BIN" ` in a shell command, that record `seq` on pane
 * `target` and drop the records beyond the TERMINAL_INPUT_RECORD_STREAMS most recently written.
 * The command fails only when the record was not set.
 */
export function tmuxInputRecordArgs(target: string, seq: TerminalInputSequence): string {
  const pane = shellQuote(target);
  const option = shellQuote(terminalInputRecordOption(seq.stream));
  const value = shellQuote(formatTerminalInputRecord(seq.n, Date.now()));
  const prune =
    `"$TMUX_BIN" show-options -p -t ${pane} | ${STALE_RECORDS_FILTER}` +
    ` | while read -r name; do "$TMUX_BIN" set-option -p -u -t ${pane} "$name"; done`;
  return `set-option -p -t ${pane} ${option} ${value} && ${prune}`;
}

/**
 * Shell filter from `show-options -p` lines to the record options to unset, as protocol
 * `staleTerminalInputRecords` picks them: all but the most recently written.
 */
export const STALE_RECORDS_FILTER =
  `sed -n 's/^\\(${TERMINAL_INPUT_RECORD_PREFIX}[A-Za-z0-9_-]*\\) "*[0-9]*:\\([0-9]*\\)"*$/\\2 \\1/p'` +
  ` | sort -rn | tail -n +${TERMINAL_INPUT_RECORD_STREAMS + 1} | cut -d ' ' -f 2`;

/**
 * The record of tmux pane `target`, read and written by `run` on the pane's host (a shell
 * command line, as `execOnSlot` takes).
 */
export function tmuxPaneInputRecord(
  target: string,
  run: (command: string) => Promise<ExecResult>,
): PaneInputRecord {
  const checked = async (command: string) => {
    const result = await run(command);
    if (result.exitCode === 0) return result.stdout;
    const message = `tmux failed: ${result.stderr?.trim() || `exit ${result.exitCode}`}`;
    // tmux before 3.0 refuses `-p` with its usage.
    throw /unknown (flag|option)|usage:/i.test(result.stderr ?? '')
      ? recordsUnsupported()
      : new Error(message);
  };
  return {
    read: async (stream) =>
      parseTerminalInputRecord(
        await checked(
          tmuxShellSnippet(
            `show-options -pqv -t ${shellQuote(target)} ${shellQuote(terminalInputRecordOption(stream))}`,
          ),
        ),
      ),
    write: async (seq) => {
      await checked(tmuxShellSnippet(tmuxInputRecordArgs(target, seq)));
    },
  };
}

/** The record of a pane on `machine`: read and written through its node, or here when local. */
export function machinePaneInputRecord(
  target: string,
  machine: string,
  local: boolean,
): PaneInputRecord {
  return tmuxPaneInputRecord(target, (command) =>
    local
      ? execLocal(command, { timeout: 5_000 })
      : nodeExec(machine, command, undefined, { timeout: 5_000 }),
  );
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

function remember(
  pane: string,
  seq: TerminalInputSequence,
  uncertain: boolean,
  recordedWithKeys = false,
): void {
  const streams = written.get(pane) ?? new Map<string, Written>();
  written.delete(pane);
  written.set(pane, streams);
  streams.delete(seq.stream);
  streams.set(seq.stream, { n: seq.n, uncertain, recordedWithKeys });
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
  recording.clear();
}
