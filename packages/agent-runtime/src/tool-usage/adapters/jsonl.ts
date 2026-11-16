import { readFile } from 'node:fs/promises';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Complete JSONL objects. A missing file throws; a malformed line is skipped. */
export async function readJsonLines(file: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      // A runner still writing leaves a partial last line; the complete records stand.
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (isRecord(value)) records.push(value);
  }
  return records;
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** `{ tokensBefore }` when the transcript records a usable count, else nothing. */
export function tokensBefore(value: unknown): { tokensBefore?: number } {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { tokensBefore: value } : {};
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** ISO time from an ISO string or epoch seconds/milliseconds. */
export function isoTime(value: unknown): string | undefined {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? value : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}
