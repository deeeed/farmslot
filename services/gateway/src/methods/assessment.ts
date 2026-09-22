import type {
  AssessmentEvaluationParams,
  AssessmentFeedbackParams,
  AssessmentHistoryParams,
  AssessmentRecordParams,
  AssessmentReportParams,
  AssessmentTestParams,
} from '@farmslot/protocol';

import { assess, assessmentProviderStatus } from '../assessment/index.js';
import { monitorAssessment } from '../assessment/monitor.js';
import {
  assessmentHistory,
  assessmentRecord,
  assessmentRecords,
  recordAssessmentFeedback,
} from '../assessment/store.js';
import { summarizeAssessments } from '../assessment/summary.js';
import { currentSessionOriginator } from '../security/work-originator.js';

function assertParams(params: unknown, allowed: string[]): void {
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid assessment parameters');
}
function owner(): string {
  const origin = currentSessionOriginator();
  if (origin.kind !== 'principal') throw new Error('Authenticated principal required');
  return origin.principalId;
}

/** Local credential presence only; no provider request and no configuration write. */
export const assessmentStatus = assessmentProviderStatus;

export async function assessmentTest(params: AssessmentTestParams = {}) {
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => !['provider', 'model'].includes(key)) ||
    Object.values(params).some(
      (value) => typeof value !== 'string' || !/^[\w.-]{1,100}$/.test(value),
    )
  ) {
    throw new Error('Invalid assessment test parameters');
  }
  const operation = () =>
    assess({
      ...params,
      enabled: true,
      state: { color: 'blue' },
      questions: {
        color: {
          type: 'choice',
          instructions: 'Which color is supplied in the state?',
          criteria: { blue: 'Blue', red: 'Red' },
        },
      },
    });
  const result = await monitorAssessment(
    { ownerId: owner(), consumer: 'smoke-test', subject: {} },
    operation,
  );
  return 'assessment' in result ? result.assessment : result;
}

export async function assessmentList(params: AssessmentHistoryParams) {
  assertParams(params, ['before', 'limit', 'consumer']);
  return assessmentHistory(owner(), params);
}
export async function assessmentFeedback(params: AssessmentFeedbackParams) {
  assertParams(params, [
    'id',
    'expectedRevision',
    'questionId',
    'verdict',
    'adviceUsed',
    'adviceShown',
    'evidenceRef',
    'correctedAnswer',
  ]);
  return recordAssessmentFeedback(owner(), params);
}
export async function assessmentSummary() {
  return summarizeAssessments(await assessmentRecords(owner()));
}

export async function assessmentExport(params: AssessmentReportParams) {
  assertParams(params, ['id', 'assessmentId']);
  const { assessmentReport } = await import('../assessment/report.js');
  return assessmentReport(owner(), params.id, params.assessmentId);
}

export async function assessmentGet(params: AssessmentRecordParams) {
  assertParams(params, ['id']);
  return assessmentRecord(owner(), params.id);
}

export async function assessmentEvaluate(params: AssessmentEvaluationParams) {
  assertParams(params, ['reportId', 'references', 'pair']);
  const { assessmentEvaluate: evaluate } = await import('../assessment/evaluation.js');
  return evaluate(owner(), params);
}
