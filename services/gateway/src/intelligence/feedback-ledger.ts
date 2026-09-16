// feedback-ledger.ts — durable record of which canonical rule consumed which
// PR feedback candidate. Gateway-owned and machine-local (under the farmslot
// home), never committed: it links provider comment identities to the
// destination that absorbed them so repeated scans, repair pushes and edited
// comments never re-propose an already-landed lesson.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FeedbackConsumption } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { writeAtomicJSON } from '../core/atomic-json.js';

export interface FeedbackLedgerEntry extends FeedbackConsumption {
  sourceKey: string;
  candidateId: string;
  /** How the consumption was recorded. */
  source: 'approved-audit' | 'learnings-draft';
  runIds?: string[];
}

export interface FeedbackLedger {
  version: 1;
  entries: FeedbackLedgerEntry[];
}

export function feedbackLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FARMSLOT_FEEDBACK_LEDGER?.trim();
  if (override) return override;
  return path.join(farmslotHome(env), 'state', 'feedback-ledger.json');
}

function assertLedgerShape(value: unknown, file: string): FeedbackLedger {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    throw new Error(`feedback ledger ${file} is not a version-1 ledger`);
  }
  for (const entry of (value as FeedbackLedger).entries) {
    if (
      !entry ||
      typeof entry.sourceKey !== 'string' ||
      typeof entry.candidateId !== 'string' ||
      typeof entry.revision !== 'string' ||
      typeof entry.destination !== 'string' ||
      typeof entry.rule !== 'string' ||
      typeof entry.recordedAt !== 'string'
    ) {
      throw new Error(`feedback ledger ${file} has a malformed entry`);
    }
  }
  return value as FeedbackLedger;
}

/** A missing ledger is an empty ledger; a malformed one is an error, never silently ignored. */
export async function readFeedbackLedger(file = feedbackLedgerPath()): Promise<FeedbackLedger> {
  if (!existsSync(file)) return { version: 1, entries: [] };
  return assertLedgerShape(JSON.parse(await readFile(file, 'utf-8')), file);
}

/** Consumption identity: the same revision of a candidate landing under the same rule/destination. */
export function feedbackConsumptionKey(
  entry: Pick<FeedbackLedgerEntry, 'sourceKey' | 'destination' | 'rule' | 'revision'>,
): string {
  return `${entry.sourceKey}\u0000${entry.destination}\u0000${entry.rule}\u0000${entry.revision}`;
}

// Read-modify-write on one file: serialize appends within the gateway process so
// two approvals resolving together cannot drop each other's entries (an atomic
// rename protects the bytes, not the merge).
let ledgerQueue: Promise<unknown> = Promise.resolve();

/**
 * Append consumptions. Identity is (sourceKey, destination, rule, revision):
 * recording the same consumption twice is a no-op so a retried approval cannot
 * double count, while landing an edited revision under an existing rule adds a
 * new record. Returns the entries that were actually added.
 */
export function appendFeedbackConsumptions(
  entries: FeedbackLedgerEntry[],
  file = feedbackLedgerPath(),
): Promise<FeedbackLedgerEntry[]> {
  const run = async () => {
    const ledger = await readFeedbackLedger(file);
    const seen = new Set(ledger.entries.map(feedbackConsumptionKey));
    const added: FeedbackLedgerEntry[] = [];
    for (const entry of entries) {
      const key = feedbackConsumptionKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      ledger.entries.push(entry);
      added.push(entry);
    }
    if (added.length > 0) await writeAtomicJSON(file, ledger);
    return added;
  };
  const next = ledgerQueue.then(run, run);
  // The caller receives `next` (and its rejection); the chain itself only needs
  // to outlive a failed append so the following append still runs.
  ledgerQueue = next.catch(() => undefined);
  return next;
}

export function consumptionsBySourceKey(
  ledger: FeedbackLedger,
): Map<string, FeedbackLedgerEntry[]> {
  const map = new Map<string, FeedbackLedgerEntry[]>();
  for (const entry of ledger.entries) {
    const list = map.get(entry.sourceKey) ?? [];
    list.push(entry);
    map.set(entry.sourceKey, list);
  }
  return map;
}
