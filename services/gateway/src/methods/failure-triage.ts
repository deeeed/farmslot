import type {
  FailureTriageAnalyzeParams,
  FailureTriageFeedbackParams,
  FailureTriageGetParams,
} from '@farmslot/protocol';

import { assessmentRecord, recordAssessmentFeedback } from '../assessment/store.js';
import { analyzeFailureTriage, getFailureTriage } from '../intelligence/triage/service.js';
import { currentSessionOriginator } from '../security/work-originator.js';

function owner(): string {
  const origin = currentSessionOriginator();
  if (origin.kind !== 'principal') throw new Error('Authenticated principal required');
  return origin.principalId;
}
function validate(params: FailureTriageGetParams, analyze = false): void {
  const allowed = [
    'runId',
    'step',
    'includeEvidence',
    ...(analyze ? ['snapshotHash', 'retryOf'] : []),
  ];
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some((k) => !allowed.includes(k)) ||
    typeof params.runId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(params.runId) ||
    (params.step !== undefined &&
      (typeof params.step !== 'string' || !/^[\w .-]{1,100}$/.test(params.step))) ||
    (params.includeEvidence !== undefined && typeof params.includeEvidence !== 'boolean')
  )
    throw new Error('Invalid triage parameters');
}
export function failureTriageGet(params: FailureTriageGetParams) {
  validate(params);
  return getFailureTriage(owner(), params);
}
export function failureTriageAnalyze(params: FailureTriageAnalyzeParams) {
  validate(params, true);
  if (
    typeof params.snapshotHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(params.snapshotHash) ||
    (params.retryOf !== undefined &&
      (typeof params.retryOf !== 'string' || !/^[a-f0-9-]{36}$/.test(params.retryOf)))
  )
    throw new Error('Invalid triage snapshot or retry identity');
  return analyzeFailureTriage(owner(), params);
}
export async function failureTriageFeedback(params: FailureTriageFeedbackParams) {
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some(
      (k) =>
        ![
          'id',
          'expectedRevision',
          'questionId',
          'verdict',
          'adviceUsed',
          'adviceShown',
          'evidenceRef',
          'correctedAnswer',
        ].includes(k),
    )
  )
    throw new Error('Invalid triage feedback');
  const principal = owner();
  const record = await assessmentRecord(principal, params.id);
  if (record.consumer !== 'failure-triage') throw new Error('Select a triage assessment');
  return recordAssessmentFeedback(principal, params);
}
