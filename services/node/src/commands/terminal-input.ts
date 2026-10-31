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

/**
 * Types each (pane, stream, n) once. After typing a batch the pane records it in a user option, so
 * the same batch sent again after a lost reply, by this or a restarted gateway, is acknowledged
 * without typing. Writes to one pane run in order, so a resend waits for the write it repeats.
 * A crash between typing and recording leaves that one batch unrecorded.
 */
export function createTerminalInputWriter(run: RunTmux, now: () => number = Date.now) {
  const chains = new Map<string, Promise<unknown>>();

  async function typeOnce(
    pane: string,
    text: string,
    enter: boolean,
    seq: TerminalInputSequence,
  ): Promise<boolean> {
    const option = terminalInputRecordOption(seq.stream);
    const recorded = await run(['show-options', '-pqv', '-t', pane, option]).then(
      parseTerminalInputRecord,
      () => null,
    );
    if (recorded !== null && recorded >= seq.n) return false;
    await run(['send-keys', '-t', pane, text, ...(enter ? ['Enter'] : [])]);
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
