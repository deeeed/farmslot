import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NATIVE_SESSION_ARCHIVE_LIMIT, type Run } from '@farmslot/protocol';

/**
 * ADR-039 Amendment 11: a node-hosted native session's journal follows its run. Sessions of runs
 * retention released are archived on their node, out of host startup replay, unless a run that
 * retention holds still references them. A session no run references is never touched.
 */

/** One node-hosted session a run's agent contexts bound. */
export interface NodeSessionRef {
  executionNodeId: string;
  ownerPrincipalId: string;
  sessionId: string;
}

const key = (node: string, sessionId: string) => `${node}/${sessionId}`;
/** Host session ids are lowercase UUIDs; a malformed one would fail its whole batch. */
const HOST_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The node-hosted sessions a run's agent contexts bound, current and earlier. */
export function runNodeSessions(run: Run): NodeSessionRef[] {
  return (run.agentContexts ?? [])
    .flatMap((context) => [context.nativeSession, ...(context.nativeSessionHistory ?? [])])
    .flatMap((session) =>
      session &&
      session.executionNodeId !== 'local' &&
      typeof session.sessionId === 'string' &&
      HOST_SESSION_ID.test(session.sessionId) &&
      typeof session.ownerPrincipalId === 'string'
        ? [
            {
              executionNodeId: session.executionNodeId,
              ownerPrincipalId: session.ownerPrincipalId,
              sessionId: session.sessionId,
            },
          ]
        : [],
    );
}

/**
 * Every native session a run names anywhere in its record (agent contexts, usage, reviews, pause
 * recovery handles), so a held run keeps any session it might still resume or read. A recovery
 * handle names the host session as `nativeSessionId` beside the runner's own `sessionId`.
 */
export function runReferencedSessions(run: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.executionNodeId === 'string')
      for (const field of ['sessionId', 'nativeSessionId'])
        if (typeof record[field] === 'string')
          found.add(key(record.executionNodeId, record[field] as string));
    for (const item of Object.values(record)) walk(item);
  };
  walk(run);
  return found;
}

/** The archive requests of one pass, per node and owner, in the order of `released`. */
export interface NodeJournalBatch {
  executionNodeId: string;
  ownerPrincipalId: string;
  sessionIds: string[];
}

export interface NodeJournalPlan {
  batches: NodeJournalBatch[];
  /** Sessions still to archive per node, sent this pass or not. */
  pending: Record<string, number>;
  /** Sessions not sent because their node cannot take them now, per node and reason. */
  unsendable: Record<string, Record<string, number>>;
}

/**
 * The sessions to archive this pass: those of `released` runs that no `held` run references and
 * that the pass does not skip. Only sessions their node can take now (`refusal` returns no
 * reason) count toward the `limit` per node, so sessions of another owner or an offline node
 * never take the place of ones it can archive.
 */
export function nodeJournalBatches(
  released: readonly Run[],
  held: readonly Run[],
  skipped: ReadonlySet<string>,
  refusal: (node: string, owner: string) => string | undefined,
  limit = NATIVE_SESSION_ARCHIVE_LIMIT,
): NodeJournalPlan {
  const keep = new Set<string>();
  for (const run of held) for (const ref of runReferencedSessions(run)) keep.add(ref);
  const batches = new Map<string, NodeJournalBatch>();
  const pending: Record<string, number> = {};
  const unsendable: Record<string, Record<string, number>> = {};
  const sent = new Map<string, number>();
  const seen = new Set<string>();
  for (const run of released)
    for (const ref of runNodeSessions(run)) {
      const node = ref.executionNodeId;
      const id = key(node, ref.sessionId);
      if (seen.has(id)) continue;
      seen.add(id);
      if (keep.has(id) || skipped.has(id)) continue;
      pending[node] = (pending[node] ?? 0) + 1;
      const reason = refusal(node, ref.ownerPrincipalId);
      if (reason) {
        const reasons = (unsendable[node] ??= {});
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        continue;
      }
      if ((sent.get(node) ?? 0) >= limit) continue;
      sent.set(node, (sent.get(node) ?? 0) + 1);
      const batchKey = `${node}\0${ref.ownerPrincipalId}`;
      let batch = batches.get(batchKey);
      if (!batch) {
        batch = { executionNodeId: node, ownerPrincipalId: ref.ownerPrincipalId, sessionIds: [] };
        batches.set(batchKey, batch);
      }
      batch.sessionIds.push(ref.sessionId);
    }
  return { batches: [...batches.values()], pending, unsendable };
}

/**
 * What nodes answered. Sessions confirmed archived, already archived or missing are never resent.
 * `missing` is final: the node's one host root has neither the journal nor its archive, so
 * asking again cannot change the answer. Sessions a node kept wait a day before they are asked
 * about again, so they cannot crowd out the rest.
 */
export interface JournalRetentionRecord {
  version: 1;
  confirmed: Record<string, string>;
  deferred: Record<string, string>;
}

export const JOURNAL_RETRY_DEFERRAL_MS = 24 * 60 * 60 * 1000;

export const journalRetentionFile = (archiveRoot: string) =>
  path.join(archiveRoot, 'native-journals.json');

export async function readJournalRetention(file: string): Promise<JournalRetentionRecord> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<JournalRetentionRecord>;
    if (
      value.version !== 1 ||
      !value.confirmed ||
      typeof value.confirmed !== 'object' ||
      (value.deferred !== undefined && typeof value.deferred !== 'object')
    )
      throw new Error(`Unreadable native journal retention record ${file}`);
    return { version: 1, confirmed: value.confirmed, deferred: value.deferred ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, confirmed: {}, deferred: {} };
    throw error;
  }
}

/** Sessions a pass skips: confirmed ones, and kept ones still within their deferral. */
export function skippedJournals(record: JournalRetentionRecord, now: number): Set<string> {
  const skipped = new Set(Object.keys(record.confirmed));
  for (const [id, at] of Object.entries(record.deferred))
    if (now - Date.parse(at) < JOURNAL_RETRY_DEFERRAL_MS) skipped.add(id);
  return skipped;
}

/** Note one node's answers in the record: confirmed sessions stay, kept ones are deferred. */
export function noteJournalAnswers(
  record: JournalRetentionRecord,
  node: string,
  confirmed: readonly string[],
  kept: readonly string[],
  at: string,
): void {
  for (const sessionId of confirmed) {
    record.confirmed[key(node, sessionId)] ??= at;
    delete record.deferred[key(node, sessionId)];
  }
  for (const sessionId of kept) record.deferred[key(node, sessionId)] = at;
}

/**
 * Drop deferrals past their day. Confirmations stay: an archived session id is never reused, so a
 * confirmation cannot go stale, and dropping them when a run is held for a while (a GitHub outage
 * holds runs as "PR state unknown") would resend every archived session afterwards.
 */
export function pruneJournalRetention(record: JournalRetentionRecord, now: number): void {
  for (const [id, at] of Object.entries(record.deferred))
    if (now - Date.parse(at) >= JOURNAL_RETRY_DEFERRAL_MS) delete record.deferred[id];
}

/** Write the record whole and rename it into place. */
export async function writeJournalRetention(
  file: string,
  record: JournalRetentionRecord,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
  await rename(temp, file);
}
