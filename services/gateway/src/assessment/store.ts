import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  ASSESSMENT_CONSUMERS,
  assessmentChoiceOptions,
  type AssessmentFeedbackParams,
  type AssessmentHistoryParams,
  type AssessmentHistoryResult,
  type AssessmentRecord,
  type AssessmentResult,
  type AssessmentSubject,
  type ReviewIntakeAdvisory,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { writeAtomicJSON } from '../core/atomic-json.js';

import {
  assertAssessmentRecord,
  assertAssessmentSubject,
  assertNoCredentials,
  serializeAssessment,
} from './record-validation.js';

const RETENTION_DAYS = 30;
const MAX_RECORDS = 5000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const active = new Set<string>();
const nextPruneAt = new Map<string, number>();
let failedWritesSinceStart = 0;
export function assessmentAuditHealth(): import('@farmslot/protocol').AssessmentAuditHealth {
  return { status: failedWritesSinceStart ? 'degraded' : 'ok', failedWritesSinceStart };
}
export function recordAuditFailure(): void {
  failedWritesSinceStart++;
}
let tail: Promise<unknown> = Promise.resolve();

function root(): string {
  return path.join(farmslotHome(), 'assessments');
}
function location(id: string): string {
  if (!ID.test(id)) throw new Error('Invalid assessment ID');
  return path.join(root(), `${id}.json`);
}
async function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
async function load(id: string): Promise<AssessmentRecord> {
  const file = location(id);
  if ((await stat(file)).size > 256 * 1024) throw new Error('Assessment record exceeds limit');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  assertAssessmentRecord(value);
  assertNoCredentials(JSON.stringify(value));
  if (
    value.version !== 1 ||
    value.id !== id ||
    typeof value.ownerId !== 'string' ||
    !Array.isArray(value.feedback)
  )
    throw new Error('Invalid assessment record');
  return value;
}
async function files(): Promise<string[]> {
  try {
    return (await readdir(root())).filter(
      (name) => name.endsWith('.json') && ID.test(name.slice(0, -5)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function retained(prune = false): Promise<AssessmentRecord[]> {
  const names = await files();
  if (names.length > MAX_RECORDS) throw new Error('Assessment store exceeds limit');
  const records: AssessmentRecord[] = [];
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  for (const name of names) {
    const record = await load(name.slice(0, -5));
    if (Date.parse(record.startedAt) < cutoff && !active.has(location(record.id))) {
      if (prune) await rm(location(record.id));
      continue;
    }
    if (record.status === 'started' && !active.has(location(record.id)))
      record.status = 'interrupted';
    records.push(record);
  }
  return records;
}

export interface AssessmentAuditContext {
  ownerId: string;
  consumer: AssessmentRecord['consumer'];
  subject: AssessmentSubject;
  requestedIdentity?: AssessmentRecord['requestedIdentity'];
  policyVersion?: string;
}

async function createAssessment(
  context: AssessmentAuditContext,
  reservation?: AssessmentRecord['reservation'],
): Promise<AssessmentRecord> {
  assertAssessmentSubject(context.subject);
  await mkdir(root(), { recursive: true, mode: 0o700 });
  // Retention is write-side maintenance. Throttle full scans even at capacity;
  // read RPCs only filter expired rows and never mutate storage. At capacity,
  // expired space may remain unavailable until the next sweep, at most one minute.
  if (Date.now() >= (nextPruneAt.get(root()) ?? 0)) {
    await retained(true);
    nextPruneAt.set(root(), Date.now() + 60_000);
  }
  if ((await files()).length >= MAX_RECORDS)
    throw new Error('Assessment history is full; expiry sweep may free space within one minute');
  const record: AssessmentRecord = {
    version: 1,
    id: randomUUID(),
    ...context,
    startedAt: new Date().toISOString(),
    status: 'started',
    policyVersion: context.policyVersion ?? 'review-intake-v2',
    ...(reservation ? { reservation } : {}),
    feedback: [],
  };
  serializeAssessment(record);
  await writeAtomicJSON(location(record.id), record);
  active.add(location(record.id));
  return record;
}
export async function beginAssessment(context: AssessmentAuditContext): Promise<AssessmentRecord> {
  return serialized(() => createAssessment(context));
}

/** Reserve before transport. All bounded consumers share the gateway's daily allowance. */
export async function reserveAssessment(
  context: AssessmentAuditContext,
  reservation: NonNullable<AssessmentRecord['reservation']>,
  limits: { maxCalls: number; maxUsd: number },
): Promise<
  | { status: 'reserved' | 'existing'; record: AssessmentRecord }
  | { status: 'budget-blocked'; cause: 'spend-bound' | 'daily' }
> {
  if (
    !Number.isSafeInteger(limits.maxCalls) ||
    limits.maxCalls < 1 ||
    limits.maxCalls > 60 ||
    !Number.isFinite(limits.maxUsd) ||
    limits.maxUsd <= 0 ||
    limits.maxUsd > 0.1
  )
    throw new Error('Invalid assessment budget');
  return serialized(async () => {
    const records = await retained();
    const existing = records.find(
      (r) =>
        r.ownerId === context.ownerId &&
        r.consumer === context.consumer &&
        r.reservation?.key === reservation.key,
    );
    if (existing) return { status: 'existing', record: existing };
    if (
      records.some(
        (r) =>
          r.reservation?.priceHash === reservation.priceHash &&
          r.result?.error === 'spend-bound-exceeded',
      )
    )
      return { status: 'budget-blocked', cause: 'spend-bound' };
    const today = new Date().toISOString().slice(0, 10);
    const attempts = records.filter((r) => r.reservation && r.startedAt.slice(0, 10) === today);
    if (
      attempts.length >= limits.maxCalls ||
      attempts.reduce((sum, r) => sum + r.reservation!.maxUsd, 0) + reservation.maxUsd >
        limits.maxUsd + 1e-12
    )
      return { status: 'budget-blocked', cause: 'daily' };
    return { status: 'reserved', record: await createAssessment(context, reservation) };
  });
}
export async function finishAssessment(
  record: AssessmentRecord,
  result: AssessmentResult,
  recommendation?: ReviewIntakeAdvisory,
): Promise<void> {
  return serialized(async () => {
    try {
      const completed: AssessmentRecord = {
        ...record,
        completedAt: new Date().toISOString(),
        status: result.status,
        result,
        ...(recommendation ? { recommendation } : {}),
      };
      serializeAssessment(completed);
      await writeAtomicJSON(location(record.id), completed);
    } finally {
      active.delete(location(record.id));
    }
  });
}
export async function assessmentHistory(
  ownerId: string,
  params: AssessmentHistoryParams = {},
): Promise<AssessmentHistoryResult> {
  return serialized(async () => {
    const limit = params.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('History limit must be 1 to 100');
    if (
      params.before !== undefined &&
      (typeof params.before !== 'string' || params.before.length > 100)
    )
      throw new Error('Invalid history cursor');
    if (params.consumer !== undefined && !ASSESSMENT_CONSUMERS.includes(params.consumer))
      throw new Error('Invalid consumer');
    const records = (await retained())
      .filter((r) => r.ownerId === ownerId && (!params.consumer || r.consumer === params.consumer))
      .sort((a, b) => `${b.startedAt}|${b.id}`.localeCompare(`${a.startedAt}|${a.id}`))
      .filter((r) => !params.before || `${r.startedAt}|${r.id}` < params.before);
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      records: page,
      ...(records.length > limit && last ? { nextCursor: `${last.startedAt}|${last.id}` } : {}),
      retentionDays: RETENTION_DAYS,
      auditHealth: assessmentAuditHealth(),
    };
  });
}
export async function assessmentRecords(ownerId: string): Promise<AssessmentRecord[]> {
  return serialized(async () => (await retained()).filter((r) => r.ownerId === ownerId));
}
export async function recordAssessmentFeedback(
  ownerId: string,
  params: AssessmentFeedbackParams,
): Promise<AssessmentRecord> {
  return serialized(async () => {
    const record = await load(params.id);
    if (
      record.ownerId !== ownerId ||
      Date.parse(record.startedAt) < Date.now() - RETENTION_DAYS * 86400_000
    )
      throw new Error('Assessment not found or expired');
    if (
      !Number.isInteger(params.expectedRevision) ||
      params.expectedRevision !== record.feedback.length
    )
      throw new Error('Feedback changed; reload the assessment');
    if (
      record.status !== 'completed' ||
      !Object.hasOwn(record.result?.answers ?? {}, params.questionId)
    )
      throw new Error('Select a completed question');
    if (
      !['correct', 'incorrect', 'insufficient-context'].includes(params.verdict) ||
      typeof params.adviceUsed !== 'boolean'
    )
      throw new Error('Invalid assessment feedback');
    const answer = record.result?.answers?.[params.questionId];
    if (
      params.correctedAnswer !== undefined &&
      (answer?.type === 'boolean'
        ? typeof params.correctedAnswer !== 'boolean'
        : answer?.type !== 'choice' ||
          typeof params.correctedAnswer !== 'string' ||
          !assessmentChoiceOptions(answer).includes(params.correctedAnswer))
    )
      throw new Error('Correction must match the question choices');
    record.feedback.push({
      revision: record.feedback.length + 1,
      recordedAt: new Date().toISOString(),
      questionId: params.questionId,
      verdict: params.verdict,
      adviceUsed: params.adviceUsed,
      adviceShown: params.adviceShown,
      evidenceRef: params.evidenceRef,
      ...(params.correctedAnswer !== undefined ? { correctedAnswer: params.correctedAnswer } : {}),
    });
    serializeAssessment(record);
    await writeAtomicJSON(location(record.id), record);
    return record;
  });
}

export async function assessmentRecord(ownerId: string, id: string): Promise<AssessmentRecord> {
  const record = await load(id);
  if (
    record.ownerId !== ownerId ||
    Date.parse(record.startedAt) < Date.now() - RETENTION_DAYS * 86400_000
  )
    throw new Error('Assessment not found or expired');
  if (record.status === 'started' && !active.has(location(id))) record.status = 'interrupted';
  return record;
}
