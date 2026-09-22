import type { AssessmentRecord, AssessmentSummary } from '@farmslot/protocol';

export function assessmentCohort(record: AssessmentRecord) {
  return {
    consumer: record.consumer,
    provider: record.result?.provider ?? record.requestedIdentity?.provider ?? 'unknown',
    model:
      record.result?.returnedModel ??
      record.result?.requestedModel ??
      record.requestedIdentity?.model ??
      'unknown',
    questionSchemaHash:
      record.result?.questionSchemaHash ??
      record.requestedIdentity?.questionSchemaHash ??
      'unknown',
    policyVersion: record.policyVersion,
  };
}
export function assessmentCase(record: AssessmentRecord): string | undefined {
  const run = record.subject.run;
  if (record.consumer === 'failure-triage' && run)
    return JSON.stringify([
      record.consumer,
      run.id,
      run.step,
      run.snapshotHash,
      assessmentCohort(record),
    ]);
  const pr = record.subject.pr;
  return pr
    ? JSON.stringify([
        pr.host.toLowerCase(),
        pr.repo.toLowerCase(),
        pr.number,
        pr.headSha.toLowerCase(),
        assessmentCohort(record),
      ])
    : undefined;
}
/** Accounting groups requested identity so failures without a returned build stay visible. */
export function assessmentAccountingCase(record: AssessmentRecord): string | undefined {
  const run = record.subject.run;
  if (record.consumer === 'failure-triage' && run)
    return JSON.stringify([
      record.consumer,
      run.id,
      run.step,
      run.snapshotHash,
      record.requestedIdentity?.provider ?? record.result?.provider ?? 'unknown',
      record.requestedIdentity?.model ?? record.result?.requestedModel ?? 'unknown',
      record.requestedIdentity?.questionSchemaHash ??
        record.result?.questionSchemaHash ??
        'unknown',
      record.policyVersion,
    ]);
  const pr = record.subject.pr;
  if (!pr || record.consumer !== 'review-intake') return undefined;
  return JSON.stringify([
    pr.host.toLowerCase(),
    pr.repo.toLowerCase(),
    pr.number,
    pr.headSha.toLowerCase(),
    record.requestedIdentity?.provider ?? record.result?.provider ?? 'unknown',
    record.requestedIdentity?.model ?? record.result?.requestedModel ?? 'unknown',
    record.requestedIdentity?.questionSchemaHash ?? record.result?.questionSchemaHash ?? 'unknown',
    record.policyVersion,
  ]);
}
/** Pick before looking at labels. Never transfer feedback between repeated predictions. */
export function representativeAssessments(rows: AssessmentRecord[]): AssessmentRecord[] {
  const cases = new Set<string>();
  return rows
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
    .filter((r) => {
      const key = assessmentCase(r);
      if (r.consumer === 'smoke-test' || r.status !== 'completed' || !key || cases.has(key))
        return false;
      cases.add(key);
      return true;
    });
}
const percentile = (values: number[], q: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null;
};

export function summarizeAssessments(all: AssessmentRecord[]): AssessmentSummary {
  const rows = all.filter((r) => r.consumer !== 'smoke-test');
  const selectedCases = new Set(rows.map(assessmentAccountingCase).filter(Boolean));
  const completedCases = new Set(
    rows
      .filter((r) => r.status === 'completed')
      .map(assessmentAccountingCase)
      .filter(Boolean),
  );
  const timings = rows.flatMap((r) => (r.result?.usage ? [r.result.usage.durationMs] : []));
  const elapsed = rows.flatMap((r) =>
    r.completedAt ? [Date.parse(r.completedAt) - Date.parse(r.startedAt)] : [],
  );
  const groups = new Map<string, AssessmentSummary['groups'][number]>();
  for (const record of rows) {
    for (const questionId of Object.keys(record.result?.answers ?? {})) {
      const identity = { ...assessmentCohort(record), questionId };
      const key = JSON.stringify(identity);
      const group = groups.get(key) ?? {
        ...identity,
        calls: 0,
        correct: 0,
        incorrect: 0,
        insufficientContext: 0,
        unlabeled: 0,
      };
      group.calls++;
      groups.set(key, group);
    }
  }
  const representatives = representativeAssessments(rows);
  for (const record of representatives) {
    for (const questionId of Object.keys(record.result?.answers ?? {})) {
      const group = groups.get(JSON.stringify({ ...assessmentCohort(record), questionId }))!;
      const feedback = record.feedback
        .slice()
        .reverse()
        .find((f) => f.questionId === questionId);
      if (!feedback) group.unlabeled++;
      else if (feedback.verdict === 'correct') group.correct++;
      else if (feedback.verdict === 'incorrect') group.incorrect++;
      else group.insufficientContext++;
    }
  }
  const values = [...groups.values()];
  const total = (key: 'correct' | 'incorrect' | 'insufficientContext' | 'unlabeled') =>
    values.reduce((sum, g) => sum + g[key], 0);
  const correct = total('correct'),
    incorrect = total('incorrect'),
    insufficient = total('insufficientContext');
  return {
    calls: rows.length,
    selectedCases: selectedCases.size,
    completedCases: completedCases.size,
    reservedUsd: rows.reduce((n, r) => n + (r.reservation?.maxUsd ?? 0), 0),
    knownEstimatedUsd: rows.reduce(
      (n, r) => n + (r.result?.usage?.costKind === 'estimated' ? (r.result.usage.costUsd ?? 0) : 0),
      0,
    ),
    knownReportedUsd: rows.reduce(
      (n, r) =>
        n + (r.result?.usage?.costKind === 'reported' ? (r.result?.usage?.costUsd ?? 0) : 0),
      0,
    ),
    knownUnclassifiedUsd: rows.reduce(
      (n, r) => n + (r.result?.usage?.costKind === undefined ? (r.result?.usage?.costUsd ?? 0) : 0),
      0,
    ),
    unknownCharges: rows.filter(
      (r) =>
        r.result?.attempted !== false &&
        !['disabled', 'skipped'].includes(r.status) &&
        r.result?.usage?.costUsd === undefined,
    ).length,
    attemptedCalls: rows.filter((r) => r.result?.attempted === true).length,
    unknownAttemptCalls: rows.filter(
      (r) => r.result?.attempted === undefined && !['disabled', 'skipped'].includes(r.status),
    ).length,
    completed: rows.filter((r) => r.status === 'completed').length,
    failed: rows.filter((r) => r.status === 'unavailable').length,
    skipped: rows.filter((r) => r.status === 'skipped' || r.status === 'disabled').length,
    interrupted: rows.filter((r) => r.status === 'interrupted').length,
    tokens: rows.reduce(
      (sum, r) => sum + (r.result?.usage?.inputTokens ?? 0) + (r.result?.usage?.outputTokens ?? 0),
      0,
    ),
    callsWithUsage: rows.filter(
      (r) =>
        r.result?.usage?.inputTokens !== undefined && r.result.usage.outputTokens !== undefined,
    ).length,
    callsWithLatency: timings.length,
    medianLatencyMs: percentile(timings, 0.5),
    p95LatencyMs: percentile(timings, 0.95),
    endToEndMedianMs: percentile(elapsed, 0.5),
    endToEndP95Ms: percentile(elapsed, 0.95),
    uniqueCases: representatives.length,
    labeledQuestions: correct + incorrect + insufficient,
    correctQuestions: correct,
    incorrectQuestions: incorrect,
    insufficientContextQuestions: insufficient,
    accuracy: values.length === 1 && correct + incorrect ? correct / (correct + incorrect) : null,
    unlabeledQuestions: total('unlabeled'),
    savings: null,
    groups: values,
  };
}
