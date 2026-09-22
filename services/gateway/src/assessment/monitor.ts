import type { AssessmentResult, ReviewIntakeAdvisory } from '@farmslot/protocol';

import { serializeAssessment } from './record-validation.js';
import {
  type AssessmentAuditContext,
  beginAssessment,
  finishAssessment,
  recordAuditFailure,
} from './store.js';

/** Audit failures suppress optional calls; they never abort the enclosing workflow. */
export async function monitorAssessment(
  context: AssessmentAuditContext,
  operation: () => Promise<AssessmentResult | ReviewIntakeAdvisory>,
): Promise<AssessmentResult | ReviewIntakeAdvisory> {
  let record;
  try {
    record = await beginAssessment(context);
  } catch {
    recordAuditFailure();
    return {
      status: 'skipped',
      monitoringError: 'Assessment history unavailable; no provider call made',
    };
  }
  let value: AssessmentResult | ReviewIntakeAdvisory;
  try {
    value = await operation();
  } catch {
    value = { status: 'unavailable', error: 'Assessment could not be completed' };
  }
  // Validate the outbound value as well as storage. A failed write must never
  // return a rejected provider payload to the client.
  try {
    const result = 'assessment' in value ? value.assessment : value;
    serializeAssessment({
      ...record,
      status: result.status,
      result,
      ...('assessment' in value ? { recommendation: value } : {}),
    });
  } catch {
    value = { status: 'unavailable', error: 'Assessment response rejected by audit validation' };
  }
  const result = 'assessment' in value ? value.assessment : value;
  result.assessmentId = record.id;
  try {
    await finishAssessment(record, result, 'assessment' in value ? value : undefined);
  } catch {
    recordAuditFailure();
    result.monitoringError = 'Assessment result could not be saved';
  }
  return value;
}
