import { createHash } from 'node:crypto';

import {
  type AssessmentEvaluation,
  type AssessmentEvaluationParams,
  type AssessmentReferenceLabel,
  type AssessmentReport,
  isResultPackageManifest,
} from '@farmslot/protocol';

import { computePackageHash, stableJson } from '../evals/package-store.js';

import { saveAssessmentArtifact } from './artifacts.js';
import { assertNoCredentials } from './record-validation.js';
import { assessmentReport } from './report.js';
import {
  assessmentAccountingCase,
  assessmentCohort,
  representativeAssessments,
} from './summary.js';

export function wilsonInterval(correct: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.96,
    p = correct / total,
    scale = 1 + (z * z) / total,
    mid = (p + (z * z) / (2 * total)) / scale;
  const range = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / scale;
  return [Math.max(0, mid - range), Math.min(1, mid + range)];
}
function assertReferences(value: unknown): asserts value is AssessmentReferenceLabel[] {
  if (!Array.isArray(value) || value.length > 5000)
    throw new Error('References must be a bounded array');
  const keys = new Set<string>();
  for (const r of value) {
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).some(
        (k) =>
          !['assessmentId', 'questionId', 'expected', 'evidenceRef', 'source', 'blinded'].includes(
            k,
          ),
      ) ||
      typeof r.assessmentId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(r.assessmentId) ||
      typeof r.questionId !== 'string' ||
      !/^[\w.-]{1,80}$/.test(r.questionId) ||
      !['string', 'boolean'].includes(typeof r.expected) ||
      (typeof r.expected === 'string' && (r.expected.length > 80 || r.expected.length === 0)) ||
      typeof r.evidenceRef !== 'string' ||
      r.evidenceRef.length < 1 ||
      r.evidenceRef.length > 500 ||
      !['human', 'independent-model'].includes(r.source) ||
      typeof r.blinded !== 'boolean'
    )
      throw new Error('Invalid reference label');
    const key = JSON.stringify([r.assessmentId, r.questionId]);
    if (keys.has(key)) throw new Error('Duplicate reference label');
    keys.add(key);
  }
}
export function evaluateAssessmentReport(
  report: AssessmentReport,
  params: AssessmentEvaluationParams,
): Omit<AssessmentEvaluation, 'evaluationId' | 'createdAt'> {
  if (Buffer.byteLength(JSON.stringify(params)) > 2 * 1024 * 1024)
    throw new Error('Assessment evaluation input exceeds 2 MiB limit');
  assertReferences(params.references);
  assertNoCredentials(JSON.stringify(params.references));
  const labels = new Map(
    params.references.map((r) => [JSON.stringify([r.assessmentId, r.questionId]), r]),
  );
  const groups = new Map<string, AssessmentEvaluation['questions'][number]>();
  const usedLabels = new Set<string>();
  const representatives = representativeAssessments(report.records);
  const excluded = report.records.length - representatives.length;
  let missingReferences = 0,
    rejectedReferences = 0,
    unsupportedQuestions = 0;
  for (const r of representatives) {
    const cohort = JSON.stringify(assessmentCohort(r));
    for (const [questionId, answer] of Object.entries(r.result?.answers ?? {})) {
      const key = JSON.stringify([cohort, questionId]);
      const entry = groups.get(key) ?? {
        cohort,
        questionId,
        correct: 0,
        judged: 0,
        eligible: 0,
        unlabeled: 0,
        abstained: 0,
        falseNegatives: 0,
        falsePositives: 0,
        accuracy: null,
        interval95: null,
      };
      groups.set(key, entry);
      entry.eligible++;
      const abstains = r.recommendation?.route === 'needs-review' || !r.recommendation;
      if (abstains) entry.abstained++;
      const labelKey = JSON.stringify([r.id, questionId]);
      const reference = labels.get(labelKey);
      if (reference) usedLabels.add(labelKey);
      if (!reference || !reference.blinded) {
        missingReferences++;
        entry.unlabeled++;
        if (reference) rejectedReferences++;
        continue;
      }
      if (abstains) continue;
      let predicted: string | boolean;
      if (answer.type === 'choice') predicted = answer.choice;
      else if (answer.type === 'boolean') predicted = answer.probability >= 0.65;
      else {
        unsupportedQuestions++;
        continue;
      }
      if (typeof reference.expected !== typeof predicted)
        throw new Error('Reference type does not match question');
      if (
        answer.type === 'choice' &&
        !Object.hasOwn(answer.probabilities, String(reference.expected))
      )
        throw new Error('Reference choice does not match question');
      entry.judged++;
      if (predicted === reference.expected) entry.correct++;
      if (questionId === 'visualReview') {
        if (predicted === false && reference.expected === true) entry.falseNegatives++;
        if (predicted === true && reference.expected === false) entry.falsePositives++;
      }
    }
  }
  for (const g of groups.values()) {
    g.accuracy = g.judged ? g.correct / g.judged : null;
    g.interval95 = wilsonInterval(g.correct, g.judged);
  }
  let comparison: AssessmentEvaluation['comparison'] = {
    status: 'inconclusive',
    reason: 'No paired result packages supplied',
  };
  if (params.pair) {
    const { baseline: b, assisted: a } = params.pair;
    if (
      !isResultPackageManifest(b) ||
      !isResultPackageManifest(a) ||
      computePackageHash(b) !== b.packageHash ||
      computePackageHash(a) !== a.packageHash
    )
      throw new Error('Invalid or changed eval package');
    const attempts = report.records.filter((r) => r.consumer === 'review-intake');
    const accountingKey = representatives[0] && assessmentAccountingCase(representatives[0]);
    // A treatment may call a requested alias that resolves to several builds.
    // Compare usage for that one request cohort; keep accuracy grouped by returned build.
    const oneAccountingCase = Boolean(
      accountingKey && attempts.every((r) => assessmentAccountingCase(r) === accountingKey),
    );
    comparison = {
      status: 'inconclusive',
      reason: oneAccountingCase
        ? 'Packages must be final, distinct and match task, source and reviewer configuration'
        : 'Report must contain one PR/head/requested-model/policy cohort with a completed assessment',
      baselinePackageHash: b.packageHash,
      assistedPackageHash: a.packageHash,
    };
    const { assessment: ba, ...bx } = b.axes;
    const { assessment: aa, ...ax } = a.axes;
    if (
      b.status === 'final' &&
      a.status === 'final' &&
      b.packageId !== a.packageId &&
      Boolean(b.runId && a.runId && b.runId !== a.runId) &&
      Boolean(b.axes.model?.ref && b.axes.runner?.ref && b.axes.review?.ref) &&
      aa?.ref === report.reportId &&
      a.source.kind === 'merged-pr' &&
      oneAccountingCase &&
      representatives[0].subject.pr?.repo.toLowerCase() === a.source.repo.toLowerCase() &&
      representatives[0].subject.pr?.number === a.source.prNumber &&
      representatives[0].subject.pr?.headSha === a.source.headSha &&
      b.objectiveHash === a.objectiveHash &&
      b.project === a.project &&
      b.taskProfile === a.taskProfile &&
      stableJson(b.source) === stableJson(a.source) &&
      stableJson(bx) === stableJson(ax) &&
      !ba &&
      aa &&
      b.missingData.length === 0 &&
      a.missingData.length === 0
    ) {
      const bt = b.metrics?.sessionTotalTokens,
        at = a.metrics?.sessionTotalTokens,
        bd = b.metrics?.durationMs,
        ad = a.metrics?.durationMs;
      if ([bt, at, bd, ad].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))
        comparison = {
          ...comparison,
          status: 'comparable',
          reason:
            'Descriptive reported metrics only; independent findings-quality adjudication is still required',
          reportedTokenDelta: at! - bt!,
          elapsedDeltaMs: ad! - bd!,
        };
      else comparison.reason = 'Comparable packages lack reported token or duration metrics';
      if (comparison.status === 'comparable') {
        const missing = attempts.filter(
          (r) =>
            r.result?.usage?.inputTokens === undefined || r.result.usage.outputTokens === undefined,
        ).length;
        comparison.assessmentTokensStatus =
          attempts.length > 0 && missing === 0 ? 'complete' : 'partial';
        comparison.assessmentAttemptsMissingUsage = missing;
        if (comparison.assessmentTokensStatus === 'complete') {
          comparison.assessmentTokens = attempts.reduce(
            (sum, r) => sum + r.result!.usage!.inputTokens! + r.result!.usage!.outputTokens!,
            0,
          );
          comparison.totalTokenDelta = comparison.reportedTokenDelta! + comparison.assessmentTokens;
        } else {
          comparison.reason +=
            '; assessment usage is incomplete, so total token savings are unknown';
        }
      }
    }
  }
  return {
    version: 1,
    reportId: report.reportId,
    status:
      missingReferences === 0 && [...groups.values()].some((g) => g.judged > 0)
        ? 'scored'
        : 'inconclusive',
    excluded,
    missingReferences,
    rejectedReferences,
    unsupportedQuestions,
    unusedReferences: params.references.length - usedLabels.size,
    questions: [...groups.values()],
    comparison,
    limitations: [
      'Reference independence is declared by the importer; source provenance must be audited.',
      'Scored accuracy is selective accuracy; abstentions and missing labels are shown separately.',
      'A scored assessment is not evidence of review quality or causal efficiency gains.',
      'Reviewer token deltas exclude assessment overhead; totalTokenDelta adds all recorded assessment tokens when complete. Imported sessionTotalTokens must exclude assessment tokens to avoid double counting.',
      'Imported run identities, effort and matching context are declarations, not proof of independent sessions. Equal findings quality and counterbalanced order require external adjudication.',
    ],
  };
}
export async function assessmentEvaluate(
  ownerId: string,
  params: AssessmentEvaluationParams,
): Promise<AssessmentEvaluation> {
  const report = await assessmentReport(ownerId, params.reportId);
  const payload = {
    ...evaluateAssessmentReport(report, params),
    createdAt: new Date().toISOString(),
  };
  const evaluationId = createHash('sha256')
    .update(stableJson({ payload, references: params.references }))
    .digest('hex');
  const evaluation = { ...payload, evaluationId };
  // Imported result packages are verified in memory; retain only their hashes and
  // derived metrics, never their arbitrary artifact metadata or raw task fields.
  await saveAssessmentArtifact(ownerId, 'evaluations', evaluationId, {
    evaluation,
    references: params.references,
  });
  return evaluation;
}
