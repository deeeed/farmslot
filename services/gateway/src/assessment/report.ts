import { createHash } from 'node:crypto';

import type { AssessmentReport } from '@farmslot/protocol';

import { stableJson } from '../evals/package-store.js';

import { readAssessmentArtifact, saveAssessmentArtifact } from './artifacts.js';
import { assertAssessmentRecord } from './record-validation.js';
import { assessmentRecord, assessmentRecords } from './store.js';
import { assessmentAccountingCase, summarizeAssessments } from './summary.js';

export async function assessmentReport(
  ownerId: string,
  id?: string,
  assessmentId?: string,
): Promise<AssessmentReport> {
  if (id !== undefined && assessmentId !== undefined)
    throw new Error('Select an existing report or an assessment cohort');
  if (id !== undefined) {
    const value = await readAssessmentArtifact(ownerId, 'reports', id);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid report');
    const report = value as AssessmentReport;
    const { reportId: storedId, ...payload } = report;
    if (
      storedId !== id ||
      createHash('sha256').update(stableJson(payload)).digest('hex') !== id ||
      report.version !== 1 ||
      report.scope !== 'observational' ||
      !Array.isArray(report.records)
    )
      throw new Error('Invalid or changed report');
    for (const record of report.records) {
      assertAssessmentRecord(record);
      if (record.ownerId !== ownerId) throw new Error('Invalid report owner');
    }
    return report;
  }
  let records = await assessmentRecords(ownerId);
  if (assessmentId !== undefined) {
    const anchor = await assessmentRecord(ownerId, assessmentId);
    const key = assessmentAccountingCase(anchor);
    if (!key || anchor.status !== 'completed' || anchor.consumer !== 'review-intake')
      throw new Error('Select a completed review assessment');
    records = records.filter((r) => assessmentAccountingCase(r) === key);
  }
  const payload = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    scope: 'observational' as const,
    records,
    summary: summarizeAssessments(records),
    limitations: [
      'Operator labels are observational, not independent reference truth.',
      'Smoke tests are excluded from effectiveness totals.',
      'Only retained assessment history is included; no raw model inputs are stored.',
      'Savings are unknown until independent baseline and assisted review trials are compared.',
      'No model suggestion authorizes a review, dispatch, publication or merge.',
    ],
  };
  const reportId = createHash('sha256').update(stableJson(payload)).digest('hex');
  const report = { ...payload, reportId };
  await saveAssessmentArtifact(ownerId, 'reports', reportId, report);
  return report;
}
