/**
 * A tmux pane keeps, per input stream, the last batch typed into it, in a pane user option
 * `@farmslot-input-<stream>` set to `<n>:<epoch ms>`. The record lives as long as the pane, so a
 * batch resent after a lost reply is recognised whichever gateway or node process receives it.
 */
export const TERMINAL_INPUT_RECORD_PREFIX = '@farmslot-input-';

/** Streams a pane keeps a record for; the least recently written are dropped first. */
export const TERMINAL_INPUT_RECORD_STREAMS = 16;

const STREAM = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD = /^(@farmslot-input-[A-Za-z0-9_-]{1,64})\s+"?(\d+):(\d+)"?$/;

/** A stream id that can name a pane option: 1-64 letters, digits, `_` or `-`. */
export function isTerminalInputStream(stream: unknown): stream is string {
  return typeof stream === 'string' && STREAM.test(stream);
}

export function terminalInputRecordOption(stream: string): string {
  return `${TERMINAL_INPUT_RECORD_PREFIX}${stream}`;
}

export function formatTerminalInputRecord(n: number, at: number): string {
  return `${n}:${at}`;
}

/** The batch number in one record (`show-options -pqv` output), or null when there is none. */
export function parseTerminalInputRecord(value: string): number | null {
  const match = /^"?(\d+):\d+"?$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Options to unset after a write, given a pane's `show-options -p` output: every record beyond the
 * TERMINAL_INPUT_RECORD_STREAMS most recently written.
 */
export function staleTerminalInputRecords(paneOptions: string): string[] {
  const records: Array<{ option: string; at: number }> = [];
  for (const line of paneOptions.split('\n')) {
    const match = RECORD.exec(line.trim());
    if (match) records.push({ option: match[1]!, at: Number(match[3]) });
  }
  return records
    .sort((a, b) => b.at - a.at)
    .slice(TERMINAL_INPUT_RECORD_STREAMS)
    .map((record) => record.option);
}
