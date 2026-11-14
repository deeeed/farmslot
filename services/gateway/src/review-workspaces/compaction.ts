import { createHash } from 'node:crypto';

import {
  isRecord,
  isTerminalRunStatus,
  type NativeContextCompactionRecord,
  type NativeContextCompactionRequest,
} from '@farmslot/protocol';

import { NativeWorkerOperationUncertainError } from '../runners/native/worker-error.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

export interface ReviewCompactionPreparation {
  packetDigest: string;
  focus: string;
}
export interface ReviewCompactionInput {
  runId: string;
  preparation?: ReviewCompactionPreparation;
  providerSessionId: string;
  unfinishedRecovery?: boolean;
  assertCurrent: () => void | Promise<void>;
  execute: (request: NativeContextCompactionRequest) => Promise<unknown>;
  reconcile: (operationId: string) => Promise<unknown>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function receipt(
  value: unknown,
  expected: NativeContextCompactionRequest,
): NativeContextCompactionRecord {
  if (
    !isRecord(value) ||
    value.operationId !== expected.operationId ||
    value.lineageId !== expected.lineageId ||
    value.packetDigest !== expected.packetDigest ||
    value.nativeSessionId !== expected.nativeSessionId ||
    value.focusSha256 !== hash(expected.focus) ||
    typeof value.requestedAt !== 'string'
  )
    throw new Error('Context compaction receipt does not match the reserved session and packet');
  const status = value.status;
  if (!['pending', 'confirmed', 'unsupported', 'unconfirmed'].includes(String(status)))
    throw new Error('Invalid compaction receipt state');
  const record: NativeContextCompactionRecord = {
    operationId: expected.operationId,
    lineageId: expected.lineageId,
    packetDigest: expected.packetDigest,
    nativeSessionId: expected.nativeSessionId,
    focusSha256: hash(expected.focus),
    requestedAt: value.requestedAt,
    status:
      status === 'confirmed' || status === 'unsupported' || status === 'unconfirmed'
        ? status
        : 'pending',
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
  if (status === 'confirmed') {
    const evidence = value.evidence;
    if (
      !isRecord(evidence) ||
      evidence.nativeSessionId !== expected.nativeSessionId ||
      typeof evidence.boundaryId !== 'string' ||
      !evidence.boundaryId ||
      typeof evidence.completedAt !== 'string'
    )
      throw new Error('Compaction completion lacks exact-session structured evidence');
    const count = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
    record.evidence = {
      nativeSessionId: expected.nativeSessionId,
      boundaryId: evidence.boundaryId,
      completedAt: evidence.completedAt,
      preTokens: count(evidence.preTokens),
      postTokens: count(evidence.postTokens),
      durationMs: count(evidence.durationMs),
    };
  }
  return record;
}

async function checkpoint(input: ReviewCompactionInput, record: NativeContextCompactionRecord) {
  await input.assertCurrent();
  const run = getRun(input.runId);
  const context = run?.repeatReviewContext;
  const session = context?.session;
  if (
    !run ||
    isTerminalRunStatus(run.status) ||
    !context ||
    !session ||
    session.reviewId !== record.lineageId ||
    session.priorSessionId !== record.nativeSessionId
  )
    throw new Error('Review continuation changed before its compaction checkpoint');
  await persistRunNow(
    updateRun(run.id, {
      repeatReviewContext: { ...context, session: { ...session, compaction: record } },
    }),
    'review continuation compaction',
  );
  await input.assertCurrent();
}

export function unsupportedCompaction(
  request: NativeContextCompactionRequest,
  reason: string,
): NativeContextCompactionRecord {
  return {
    operationId: request.operationId,
    lineageId: request.lineageId,
    packetDigest: request.packetDigest,
    nativeSessionId: request.nativeSessionId,
    focusSha256: hash(request.focus),
    requestedAt: new Date().toISOString(),
    status: 'unsupported',
    reason,
  };
}

async function readCompaction(input: ReviewCompactionInput, operationId: string): Promise<unknown> {
  try {
    return await input.reconcile(operationId);
  } catch (error) {
    await input.assertCurrent();
    throw new NativeWorkerOperationUncertainError(
      'delivery',
      'Compaction receipt is unavailable; the reserved session remains fenced.',
      error,
    );
  }
}

async function checkedReceipt(
  input: ReviewCompactionInput,
  value: unknown,
  request: NativeContextCompactionRequest,
): Promise<NativeContextCompactionRecord> {
  try {
    return receipt(value, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await checkpoint(input, { ...unsupportedCompaction(request, reason), status: 'unconfirmed' });
    throw new NativeWorkerOperationUncertainError('delivery', reason, error);
  }
}

/** One maintenance intent per lineage/session/packet. Lost replies cause reads, never another send. */
export async function prepareReviewCompaction(input: ReviewCompactionInput): Promise<void> {
  if (!input.preparation) return;
  await input.assertCurrent();
  const run = getRun(input.runId);
  const trace = run?.repeatReviewContext?.session;
  if (!trace || trace.mode !== 'warm' || trace.continuity !== 'resumed' || !trace.reviewId) return;
  if (trace.priorSessionId !== input.providerSessionId)
    throw new Error('Compaction cannot replace the retained conversation');
  const request: NativeContextCompactionRequest = {
    operationId: hash(
      JSON.stringify([trace.reviewId, input.providerSessionId, input.preparation.packetDigest]),
    ),
    lineageId: trace.reviewId,
    nativeSessionId: input.providerSessionId,
    packetDigest: input.preparation.packetDigest,
    focus: input.preparation.focus,
  };
  const previous = trace.compaction;
  if (previous && previous.operationId === request.operationId) {
    const saved = await checkedReceipt(input, previous, request);
    if (saved.status === 'confirmed' || saved.status === 'unsupported') return;
    const reconciled = await readCompaction(input, request.operationId);
    if (reconciled) {
      const known = await checkedReceipt(input, reconciled, request);
      await checkpoint(input, known);
      if (known.status === 'confirmed' || known.status === 'unsupported') return;
    }
    throw new NativeWorkerOperationUncertainError(
      'delivery',
      'Review compaction remains unconfirmed; its reserved session is retained.',
      undefined,
    );
  }
  if (previous && ['pending', 'unconfirmed'].includes(previous.status))
    throw new NativeWorkerOperationUncertainError(
      'delivery',
      'An earlier compaction must be reconciled before binding another packet.',
      undefined,
    );
  if (input.unfinishedRecovery) return;
  const pending: NativeContextCompactionRecord = {
    ...unsupportedCompaction(request, ''),
    status: 'pending',
  };
  delete pending.reason;
  await checkpoint(input, pending);
  let result: unknown;
  try {
    result = await input.execute(request);
  } catch (error) {
    await input.assertCurrent();
    await checkpoint(input, {
      ...pending,
      status: 'unconfirmed',
      reason: error instanceof Error ? error.message : String(error),
    });
    result = await readCompaction(input, request.operationId);
    if (!result)
      throw new NativeWorkerOperationUncertainError(
        'delivery',
        'Compaction delivery is uncertain; no replacement or delta delivery was started.',
        error,
      );
  }
  const known = await checkedReceipt(input, result, request);
  await checkpoint(input, known);
  if (known.status !== 'confirmed' && known.status !== 'unsupported')
    throw new NativeWorkerOperationUncertainError(
      'delivery',
      'Compaction is pending or unconfirmed; delta delivery remains fenced.',
      undefined,
    );
}
