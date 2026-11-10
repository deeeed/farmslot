import { appendFile } from 'node:fs/promises';

import type { PRReviewIntent } from '@farmslot/protocol';

/** Withdrawn and failed intents this long past their last update are reduced to a stub. */
export const INTENT_ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000;
// waitingReason stays: every scan sets it again on a withdrawn intent, which would re-archive it.
const DISPLAY_FIELDS = ['title', 'author'] as const;
const DETAIL_FIELDS = ['reviewObservation', 'execution', 'policySources'] as const;

/** The append-only archive beside a rule store: `.pr-rules.json` → `.pr-rules.archive.jsonl`. */
export function intentArchiveFile(storeFile: string): string {
  return `${storeFile.replace(/\.json$/u, '')}.archive.jsonl`;
}

/**
 * Reduces old terminal intents to what the store still reads, and returns their full records for
 * the archive. A stub keeps its id, round, PR, head, profile, status and contribution identities:
 * a failed intent still stops a re-review of its head, ids and rounds still count it, and review
 * purpose still matches. Only ineligible contributions lose their details; one that becomes
 * eligible again is rewritten in full by the rule scan. Display fields go only from withdrawn
 * intents, which the scan redisplays if they come back.
 */
export function slimTerminalIntents(intents: PRReviewIntent[], now: number): PRReviewIntent[] {
  const archived: PRReviewIntent[] = [];
  for (const intent of intents) {
    if (intent.status !== 'withdrawn' && intent.status !== 'failed') continue;
    if (now - Date.parse(intent.updatedAt) < INTENT_ARCHIVE_AGE_MS) continue;
    const display =
      intent.status === 'withdrawn' && DISPLAY_FIELDS.some((key) => intent[key] !== undefined);
    const detail = intent.contributions.some(
      (source) =>
        !source.eligible &&
        (source.reasons.length > 0 || DETAIL_FIELDS.some((key) => source[key] !== undefined)),
    );
    if (!display && !detail) continue;
    archived.push(structuredClone(intent));
    if (intent.status === 'withdrawn') for (const key of DISPLAY_FIELDS) delete intent[key];
    for (const source of intent.contributions) {
      if (source.eligible) continue;
      for (const key of DETAIL_FIELDS) delete source[key];
      source.reasons = [];
    }
  }
  return archived;
}

/** Appends full intent records; the archive is never rewritten or trimmed. */
export async function appendIntentArchive(
  file: string,
  intents: readonly PRReviewIntent[],
  now: number,
): Promise<void> {
  if (!intents.length) return;
  const archivedAt = new Date(now).toISOString();
  await appendFile(
    file,
    intents.map((intent) => `${JSON.stringify({ archivedAt, intent })}\n`).join(''),
    { mode: 0o600 },
  );
}
