import {
  formatTerminalInputRecord,
  isTerminalInputStream,
  parseTerminalInputRecord,
  staleTerminalInputRecords,
  terminalInputRecordOption,
  type TerminalInputSequence,
} from '@farmslot/protocol';

type RunTmux = (args: string[]) => Promise<string>;

/** `tmux.send` with `seq`: the stream and number of a terminal input batch, or an error. */
export function requireInputSequence(value: unknown): TerminalInputSequence {
  const seq = value as Partial<TerminalInputSequence> | null;
  if (
    typeof seq !== 'object' ||
    seq === null ||
    !isTerminalInputStream(seq.stream) ||
    !Number.isSafeInteger(seq.n) ||
    seq.n! < 0
  )
    throw new Error(
      'seq needs a stream of 1-64 letters, digits, _ or - and a non-negative integer n',
    );
  return { stream: seq.stream, n: seq.n! };
}

/** Streams remembered per pane, and panes remembered, besides the record on each pane. */
const MAX_STREAMS_PER_PANE = 16;
const MAX_PANES = 512;

/** tmux 3.0 added pane options, where the record is kept. */
export function tmuxKeepsPaneOptions(version: string): boolean {
  const match = /tmux (?:next-)?(\d+)\./.exec(version);
  return match ? Number(match[1]) >= 3 : /tmux master/.test(version);
}

/**
 * Types each (pane, stream, n) once. After typing a batch the pane records it in a user option, so
 * the same batch sent again after a lost reply, by this or a restarted gateway, is acknowledged
 * without typing; this process also remembers it, in case the record could not be set. A record
 * that cannot be read fails the batch untyped. Writes to one pane run in order, so a resend waits
 * for the write it repeats. A node restart between typing and recording forgets that batch.
 */
export function createTerminalInputWriter(run: RunTmux, now: () => number = Date.now) {
  const chains = new Map<string, Promise<unknown>>();
  const typed = new Map<string, Map<string, number>>();

  function remember(pane: string, seq: TerminalInputSequence): void {
    const streams = typed.get(pane) ?? new Map<string, number>();
    typed.delete(pane);
    typed.set(pane, streams);
    streams.delete(seq.stream);
    streams.set(seq.stream, seq.n);
    if (streams.size > MAX_STREAMS_PER_PANE) streams.delete(streams.keys().next().value!);
    if (typed.size > MAX_PANES) typed.delete(typed.keys().next().value!);
  }

  async function typeOnce(
    pane: string,
    text: string,
    enter: boolean,
    seq: TerminalInputSequence,
  ): Promise<boolean> {
    if ((typed.get(pane)?.get(seq.stream) ?? -1) >= seq.n) return false;
    const option = terminalInputRecordOption(seq.stream);
    const recorded = parseTerminalInputRecord(
      await run(['show-options', '-pqv', '-t', pane, option]),
    );
    if (recorded !== null && recorded >= seq.n) return false;
    await run(['send-keys', '-t', pane, text, ...(enter ? ['Enter'] : [])]);
    remember(pane, seq);
    try {
      await run(['set-option', '-p', '-t', pane, option, formatTerminalInputRecord(seq.n, now())]);
      const stale = staleTerminalInputRecords(await run(['show-options', '-p', '-t', pane]));
      for (const name of stale) await run(['set-option', '-p', '-u', '-t', pane, name]);
    } catch (error) {
      // The keys are in the pane: answering an error would only get them typed again.
      console.warn(
        `[tmux.send] typed but not recorded on ${pane}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  /** Resolves true when it typed the batch, false when the pane already had it. */
  return async function sendOnce(
    pane: string,
    text: string,
    enter: boolean,
    seq: TerminalInputSequence,
  ): Promise<boolean> {
    const previous = chains.get(pane) ?? Promise.resolve();
    const current = previous.then(() => typeOnce(pane, text, enter, seq));
    const settled = current.catch(() => undefined);
    chains.set(pane, settled);
    try {
      return await current;
    } finally {
      if (chains.get(pane) === settled) chains.delete(pane);
    }
  };
}
