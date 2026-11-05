// run-engine/diff-artifact-utils.ts — Small IO/hash/timeout helpers for diff artifact capture.

import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export function parseDiffTooLargeBytes(stderr: string): number | null {
  const match = stderr.match(/(?:^|\n)farmslot-diff-bytes=(\d+)(?:\n|$)/);
  if (!match) return null;
  const bytes = Number(match[1]);
  return Number.isFinite(bytes) ? bytes : null;
}

export async function atomicWriteTextFile(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await rm(tmpPath, { force: true });
    } catch (cleanupErr) {
      console.warn(
        `[run-engine] failed to remove temp artifact ${tmpPath} after write failure: ${(cleanupErr as Error).message.slice(0, 200)}`,
      );
    }
    throw err;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  options: { onTimeout?: () => void } = {},
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // This is a latency guard for best-effort review-input capture; callers can
    // attach onTimeout cancellation for subprocess-backed work.
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          options.onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
