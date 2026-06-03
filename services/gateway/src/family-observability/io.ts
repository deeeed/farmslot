// io.ts — Optional artifact file reads for family observability

import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

export function isMissingPathError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function statIfPresent(fullPath: string): Promise<Stats | null> {
  try {
    return await stat(fullPath);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Malformed optional JSON should not break the whole family view, but it
    // must be visible because it affects provenance and missing-data counters.
    console.warn(
      `[family-observability] failed to parse JSON at ${filePath}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}
