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

/** Preserve both copies on refusal. A forced mirror cannot discard divergent rows. */
export function mergeDecisionHistoryFile(
  source: string,
  target: string,
  options: { dryRun?: boolean } = {},
): number {
  const incoming = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : '';
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if ((incoming && !incoming.endsWith('\n')) || (existing && !existing.endsWith('\n')))
    throw new Error('Cannot transport decision history with an incomplete tail');
  if (!incoming.startsWith(existing) && !existing.startsWith(incoming))
    throw new Error('Import refused: divergent decision history requires an owner decision');
  if (!options.dryRun && incoming.length > existing.length)
    appendDecisionHistoryBytes(target, incoming.slice(existing.length));
  const retained = incoming.length > existing.length ? incoming : existing;
  return retained.split('\n').length - 1;
}
