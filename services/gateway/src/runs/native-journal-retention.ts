import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NATIVE_SESSION_ARCHIVE_LIMIT, type Run } from '@farmslot/protocol';

/**
 * ADR-039 Amendment 10: a node-hosted native session's journal follows its run. Sessions of runs
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

/** The node-hosted sessions a run's agent contexts bound, current and earlier. */
export function runNodeSessions(run: Run): NodeSessionRef[] {
  return (run.agentContexts ?? [])
    .flatMap((context) => [context.nativeSession, ...(context.nativeSessionHistory ?? [])])
    .flatMap((session) =>
      session &&
      session.executionNodeId !== 'local' &&
      typeof session.sessionId === 'string' &&
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
 * Every native session a run names anywhere in its record (agent contexts, usage, reviews), so a
 * held run keeps any session it might still resume or read.
 */
export function runReferencedSessions(run: Run): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId === 'string' && typeof record.executionNodeId === 'string')
      found.add(key(record.executionNodeId, record.sessionId));
    for (const item of Object.values(record)) walk(item);
  };
  walk(run);
  return found;
}

/** The archive requests of one pass, per node and owner, oldest-settled runs first. */
export interface NodeJournalBatch {
  executionNodeId: string;
  ownerPrincipalId: string;
  sessionIds: string[];
}

/**
 * The sessions to archive this pass: those of `released` runs that no `held` run references and
 * that the pass does not skip, at most `limit` per node; `pending` counts all of them per node.
 */
export function nodeJournalBatches(
  released: readonly Run[],
  held: readonly Run[],
  skipped: ReadonlySet<string>,
  limit = NATIVE_SESSION_ARCHIVE_LIMIT,
): { batches: NodeJournalBatch[]; pending: Record<string, number> } {
  const keep = new Set<string>();
  for (const run of held) for (const ref of runReferencedSessions(run)) keep.add(ref);
  const batches = new Map<string, NodeJournalBatch>();
  const pending: Record<string, number> = {};
  const sent = new Map<string, number>();
  const seen = new Set<string>();
  for (const run of released)
    for (const ref of runNodeSessions(run)) {
      const node = ref.executionNodeId;
      const id = key(node, ref.sessionId);
      if (seen.has(id) || keep.has(id) || skipped.has(id)) continue;
      seen.add(id);
      pending[node] = (pending[node] ?? 0) + 1;
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
  return { batches: [...batches.values()], pending };
}

/**
 * What nodes answered: sessions confirmed archived (or already gone) are never resent; sessions
 * a node kept wait a day before they are asked about again, so they cannot crowd out the rest.
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

/** Record one node's answers: confirmed sessions are kept forever, kept ones deferred. */
export async function recordJournalAnswers(
  file: string,
  node: string,
  confirmed: readonly string[],
  kept: readonly string[],
  at: string,
): Promise<void> {
  if (!confirmed.length && !kept.length) return;
  const current = await readJournalRetention(file);
  for (const sessionId of confirmed) {
    current.confirmed[key(node, sessionId)] ??= at;
    delete current.deferred[key(node, sessionId)];
  }
  for (const sessionId of kept) current.deferred[key(node, sessionId)] = at;
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(current), { mode: 0o600 });
  await rename(temp, file);
}
