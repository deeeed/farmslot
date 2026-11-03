import fs from 'node:fs';
import path from 'node:path';

import type { RunDecision } from '@farmslot/protocol';

/** The journal follows its record through archive, quarantine and bundle transport. */
export function decisionHistoryFile(recordFile: string): string {
  return `${recordFile.replace(/\.json$/, '')}.decisions.jsonl`;
}

export function readDecisionHistoryFile(file: string): RunDecision[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    if (index === lines.length - 1 && !line) return [];
    try {
      return [JSON.parse(line) as RunDecision];
    } catch (error) {
      // A crash may leave only the last, unterminated row incomplete.
      if (index === lines.length - 1 && error instanceof SyntaxError) return [];
      throw error;
    }
  });
}

/** Flush bytes and the directory entry before a caller can publish a shorter list. */
export function appendDecisionHistoryBytes(file: string, bytes: string): void {
  if (!bytes) return;
  try {
    fs.mkdirSync(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      // A crash tore this append before its record changed, so the torn row is still in the
      // record and will retire again. Refusing here would block every later update to the run.
      if (last[0] !== 10) fs.ftruncateSync(fd, fs.readFileSync(file).lastIndexOf(10) + 1);
    }
    fs.appendFileSync(fd, bytes, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directory = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

export function appendDecisionHistoryFile(file: string, rows: RunDecision[]): void {
  appendDecisionHistoryBytes(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

/** Snapshot only newline-terminated rows, leaving any interrupted append untouched. */
export function captureDecisionHistoryPrefix(file: string): Buffer {
  const bytes = fs.readFileSync(file);
  return bytes.subarray(0, bytes.lastIndexOf(10) + 1);
}

/** Keep target rows in place and append surplus incoming occurrences. */
export function mergeDecisionHistoryFile(
  source: string,
  target: string,
  options: { dryRun?: boolean } = {},
): number {
  const incoming = fs.existsSync(source)
    ? captureDecisionHistoryPrefix(source).toString('utf8')
    : '';
  const existing = fs.existsSync(target)
    ? captureDecisionHistoryPrefix(target).toString('utf8')
    : '';
  const existingLines = existing.split('\n').slice(0, -1);
  const remaining = new Map<string, number>();
  for (const line of existingLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const missing = incoming
    .split('\n')
    .slice(0, -1)
    .filter((line) => {
      const count = remaining.get(line) ?? 0;
      if (!count) return true;
      remaining.set(line, count - 1);
      return false;
    });
  if (!options.dryRun)
    appendDecisionHistoryBytes(target, missing.map((line) => `${line}\n`).join(''));
  return existingLines.length + missing.length;
}
