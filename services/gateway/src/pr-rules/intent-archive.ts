import { open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PRReviewIntent } from '@farmslot/protocol';

/** Withdrawn and failed intents this long past their last update are reduced to a stub. */
export const INTENT_ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000;
const DETAIL_FIELDS = ['reviewObservation', 'execution', 'policySources'] as const;

/** The append-only archive beside a rule store: `.pr-rules.json` → `.pr-rules.archive.jsonl`. */
export function intentArchiveFile(storeFile: string): string {
  return `${storeFile.replace(/\.json$/u, '')}.archive.jsonl`;
}

/**
 * Reduces old terminal intents to what the store still reads, and returns their full records for
 * the archive. A stub keeps every intent field: a failed intent still stops a re-review of its
 * head, ids and rounds still count it, review purpose still matches, and history still shows its
 * title and author. Only ineligible contributions lose their details; one that becomes eligible
 * again is rewritten in full by the rule scan. Eligible contributions stay whole, so a failed
 * intent's run can still be observed.
 */
export function slimTerminalIntents(intents: PRReviewIntent[], now: number): PRReviewIntent[] {
  const archived: PRReviewIntent[] = [];
  for (const intent of intents) {
    if (intent.status !== 'withdrawn' && intent.status !== 'failed') continue;
    if (now - Date.parse(intent.updatedAt) < INTENT_ARCHIVE_AGE_MS) continue;
    const detail = intent.contributions.some(
      (source) =>
        !source.eligible &&
        (source.reasons.length > 0 || DETAIL_FIELDS.some((key) => source[key] !== undefined)),
    );
    if (!detail) continue;
    archived.push(structuredClone(intent));
    for (const source of intent.contributions) {
      if (source.eligible) continue;
      for (const key of DETAIL_FIELDS) delete source[key];
      source.reasons = [];
    }
  }
  return archived;
}

/**
 * Appends full intent records; the archive is never rewritten or trimmed. They are on disk before
 * this returns, so a crash after the store write cannot keep a stub whose record was lost.
 */
export async function appendIntentArchive(
  file: string,
  intents: readonly PRReviewIntent[],
  now: number,
): Promise<void> {
  if (!intents.length) return;
  const archivedAt = new Date(now).toISOString();
  const handle = await open(file, 'a', 0o600);
  try {
    const created = (await handle.stat()).size === 0;
    await handle.appendFile(
      intents.map((intent) => `${JSON.stringify({ archivedAt, intent })}\n`).join(''),
    );
    await handle.sync();
    if (created) await syncDirectory(dirname(file));
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
