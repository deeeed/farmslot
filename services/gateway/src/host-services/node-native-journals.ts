import { WebSocket } from 'ws';

import {
  NATIVE_SESSION_ARCHIVE,
  type NativeNodeSessionEnvelope,
  type NativeSessionArchiveReceipt,
  type Run,
} from '@farmslot/protocol';

import { getNode } from '../fleet/machine-registry.js';
import { requestNativeNode } from '../runners/native/node.js';
import {
  nodeJournalBatches,
  readJournalRetention,
  recordJournalAnswers,
  skippedJournals,
} from '../runs/native-journal-retention.js';
import { runSettledAt } from '../runs/retention.js';

/** A node as one archive request sees it. */
export interface JournalNode {
  connected: boolean;
  ownerPrincipalId?: string;
  supportsSessionArchive: boolean;
}

export interface NodeJournalRetentionDeps {
  node(machine: string): JournalNode;
  archive(owner: string, machine: string, sessionIds: string[]): Promise<unknown>;
  /** The record of what nodes answered, under the run archive root. */
  file: string;
  now(): number;
  log(line: string): void;
}

export function nodeJournalRetentionDeps(file: string): NodeJournalRetentionDeps {
  return {
    node(machine) {
      const node = getNode(machine);
      return {
        connected: node?.ws.readyState === WebSocket.OPEN,
        ownerPrincipalId: node?.nativeSessions?.ownerPrincipalId,
        supportsSessionArchive: node?.nativeSessions?.supportsSessionArchive === true,
      };
    },
    archive(owner, machine, sessionIds) {
      const envelope: NativeNodeSessionEnvelope = {
        owner,
        method: NATIVE_SESSION_ARCHIVE,
        params: { sessionIds },
      };
      return requestNativeNode(owner, machine, 'native.session', envelope, 60_000);
    },
    file,
    now: Date.now,
    log: (line) => console.log(line),
  };
}

function decodeReceipts(value: unknown, sent: readonly string[]): NativeSessionArchiveReceipt[] {
  const outcomes = ['archived', 'already-archived', 'missing', 'kept'];
  if (
    !Array.isArray(value) ||
    value.length !== sent.length ||
    !value.every(
      (entry, index) =>
        entry &&
        typeof entry === 'object' &&
        entry.sessionId === sent[index] &&
        outcomes.includes(entry.outcome) &&
        (entry.outcome !== 'kept' || typeof entry.reason === 'string'),
    )
  )
    throw new Error('Invalid native journal archive receipt');
  return value as NativeSessionArchiveReceipt[];
}

/**
 * One bounded batch per node per hourly retention pass (ADR-039 Amendment 11). A node that is
 * offline, or whose node or host lacks the capability, is skipped and asked again next pass.
 */
export async function nodeJournalRetentionPass(
  released: readonly Run[],
  held: readonly Run[],
  deps: NodeJournalRetentionDeps,
): Promise<void> {
  const record = await readJournalRetention(deps.file);
  const oldestFirst = [...released].sort((a, b) => runSettledAt(a) - runSettledAt(b));
  const { batches, pending } = nodeJournalBatches(
    oldestFirst,
    held,
    skippedJournals(record, deps.now()),
  );
  for (const batch of batches) {
    const machine = batch.executionNodeId;
    const node = deps.node(machine);
    const skip = !node.connected
      ? 'offline'
      : !node.supportsSessionArchive
        ? 'no session archive'
        : node.ownerPrincipalId !== batch.ownerPrincipalId
          ? 'another owner'
          : undefined;
    if (skip) {
      deps.log(
        `[native-journal retention] ${machine} skipped ${batch.sessionIds.length} (${skip}); pending=${pending[machine]}`,
      );
      continue;
    }
    try {
      const receipts = decodeReceipts(
        await deps.archive(batch.ownerPrincipalId, machine, batch.sessionIds),
        batch.sessionIds,
      );
      const count = (outcome: string) => receipts.filter((r) => r.outcome === outcome).length;
      const kept = receipts.filter((r) => r.outcome === 'kept');
      await recordJournalAnswers(
        deps.file,
        machine,
        receipts.filter((r) => r.outcome !== 'kept').map((r) => r.sessionId),
        kept.map((r) => r.sessionId),
        new Date(deps.now()).toISOString(),
      );
      const reasons = [...new Set(kept.map((r) => (r.outcome === 'kept' ? r.reason : '')))];
      deps.log(
        `[native-journal retention] ${machine} archived=${count('archived')} already=${count('already-archived')} missing=${count('missing')} kept=${kept.length}${reasons.length ? ` (${reasons.join('; ')})` : ''} pending=${pending[machine]! - receipts.length + kept.length}`,
      );
    } catch (error) {
      // The node keeps every journal it did not confirm; the next pass asks again.
      deps.log(
        `[native-journal retention] ${machine} retained on failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
