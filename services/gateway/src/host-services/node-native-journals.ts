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
  noteJournalAnswers,
  pruneJournalRetention,
  readJournalRetention,
  skippedJournals,
  writeJournalRetention,
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

const LOG = '[native-journal retention]';

/**
 * One bounded batch per node per hourly retention pass (ADR-039 Amendment 11). A node that is
 * offline, whose node or host lacks the capability, or that another owner holds is not sent
 * anything and is asked again next pass.
 */
export async function nodeJournalRetentionPass(
  released: readonly Run[],
  held: readonly Run[],
  deps: NodeJournalRetentionDeps,
): Promise<void> {
  const record = await readJournalRetention(deps.file);
  const now = deps.now();
  const nodes = new Map<string, JournalNode>();
  const refusal = (machine: string, owner: string) => {
    let node = nodes.get(machine);
    if (!node) nodes.set(machine, (node = deps.node(machine)));
    return !node.connected
      ? 'offline'
      : !node.supportsSessionArchive
        ? 'no session archive'
        : node.ownerPrincipalId !== owner
          ? 'another owner'
          : undefined;
  };
  const oldestFirst = [...released].sort((a, b) => runSettledAt(a) - runSettledAt(b));
  const plan = nodeJournalBatches(oldestFirst, held, skippedJournals(record, now), refusal);
  for (const [machine, reasons] of Object.entries(plan.unsendable))
    deps.log(
      `${LOG} ${machine} not sent ${Object.entries(reasons)
        .map(([reason, count]) => `${count} (${reason})`)
        .join(', ')}; pending=${plan.pending[machine]}`,
    );
  for (const batch of plan.batches) {
    const machine = batch.executionNodeId;
    try {
      const receipts = decodeReceipts(
        await deps.archive(batch.ownerPrincipalId, machine, batch.sessionIds),
        batch.sessionIds,
      );
      const kept = receipts.filter((receipt) => receipt.outcome === 'kept');
      const confirmed = receipts.filter((receipt) => receipt.outcome !== 'kept');
      noteJournalAnswers(
        record,
        machine,
        confirmed.map((receipt) => receipt.sessionId),
        kept.map((receipt) => receipt.sessionId),
        new Date(now).toISOString(),
      );
      const count = (outcome: string) => receipts.filter((r) => r.outcome === outcome).length;
      const reasons = [...new Set(kept.map((r) => (r.outcome === 'kept' ? r.reason : '')))];
      plan.pending[machine]! -= confirmed.length;
      deps.log(
        `${LOG} ${machine} archived=${count('archived')} already=${count('already-archived')} missing=${count('missing')} kept=${kept.length}${reasons.length ? ` (${reasons.join('; ')})` : ''} pending=${plan.pending[machine]}`,
      );
    } catch (error) {
      // The node keeps every journal it did not confirm; the next pass asks again.
      deps.log(
        `${LOG} ${machine} retained on failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  pruneJournalRetention(record, now);
  await writeJournalRetention(deps.file, record);
}
