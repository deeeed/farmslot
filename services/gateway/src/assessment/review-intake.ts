import type {
  AssessmentJsonValue,
  AssessmentRequest,
  AssessmentResult,
  PRRuleField,
  PRRuleSubject,
  ReviewIntakeAdvisory,
} from '@farmslot/protocol';

import { assess, assessmentRequestIdentity } from './index.js';
import { monitorAssessment } from './monitor.js';
import type { AssessmentAuditContext } from './store.js';

const ALLOWED_FACT_KEYS = new Set<string>([
  'repository',
  'author',
  'state',
  'draft',
  'base-branch',
  'head-branch',
  'labels',
  'changed-paths',
] as const satisfies readonly PRRuleField[]);

function asJsonValue(value: unknown): AssessmentJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
    );
  throw new Error('Review assessment state must be JSON');
}

function confidence(result: AssessmentResult, id: string): number {
  const answer = result.answers?.[id];
  return answer && 'confidence' in answer && typeof answer.confidence === 'number'
    ? answer.confidence
    : 0;
}
function booleanProbability(result: AssessmentResult, id: string): number {
  const answer = result.answers?.[id];
  return answer?.type === 'boolean' ? answer.probability : 0;
}
function choice(result: AssessmentResult, id: string): string | undefined {
  const answer = result.answers?.[id];
  return answer?.type === 'choice' ? answer.choice : undefined;
}

/** Read-only review routing hint. It never changes the review profile or admission. */
function reviewIntakeRequest(
  subject: PRRuleSubject,
  signal?: AbortSignal,
): AssessmentRequest & { signal?: AbortSignal } {
  const facts = Object.fromEntries(
    Object.entries(subject.facts).filter(([key]) => ALLOWED_FACT_KEYS.has(key)),
  );
  return {
    signal,
    state: asJsonValue({
      pullRequest: subject.pr,
      title: subject.title.slice(0, 500),
      facts,
    }),
    questions: {
      risk: {
        type: 'choice',
        instructions:
          'What review risk level does this pull request present from the supplied metadata?',
        criteria: {
          low: 'Low risk; routine or tightly scoped change',
          medium: 'Medium risk; meaningful behavior or integration change',
          high: 'High risk; broad, security-sensitive, or hard-to-prove behavior change',
        },
      },
      visualReview: {
        type: 'boolean',
        instructions:
          'Does the change require a reviewer to inspect rendered UI or other visual proof?',
      },
      reviewSurface: {
        type: 'choice',
        instructions: 'Which review surface should handle this change?',
        criteria: {
          static: 'Static code review is sufficient for the supplied scope',
          multimodal: 'A reviewer must inspect screenshots, video, or rendered UI',
          human: 'The supplied metadata is too uncertain for automated routing',
        },
      },
    },
  };
}
async function assessReviewIntakeUnrecorded(
  subject: PRRuleSubject,
  signal?: AbortSignal,
): Promise<ReviewIntakeAdvisory> {
  const assessment = await assess(reviewIntakeRequest(subject, signal));
  const advisory = reviewIntakeRecommendation(assessment);
  if (subject.facts['changed-paths']?.state !== 'known') {
    advisory.route = 'needs-review';
    advisory.reasons.push('missing-changed-path-context');
  }
  return advisory;
}

export function reviewIntakeRecommendation(assessment: AssessmentResult): ReviewIntakeAdvisory {
  const risk = choice(assessment, 'risk');
  const visualReviewRequired = booleanProbability(assessment, 'visualReview') >= 0.65;
  const surface = choice(assessment, 'reviewSurface');
  const reasons: string[] = [];
  if (risk === 'high') reasons.push('assessment-risk-high');
  if (visualReviewRequired) reasons.push('assessment-visual-review-required');
  if (surface === 'human') reasons.push('assessment-uncertain-routing');
  const visualProbability = booleanProbability(assessment, 'visualReview');
  const uncertain =
    !['low', 'medium', 'high'].includes(risk ?? '') ||
    !['static', 'multimodal', 'human'].includes(surface ?? '') ||
    assessment.answers?.visualReview?.type !== 'boolean' ||
    surface === 'human' ||
    (visualProbability > 0.35 && visualProbability < 0.65) ||
    assessment.status !== 'completed' ||
    confidence(assessment, 'reviewSurface') < 0.6 ||
    confidence(assessment, 'risk') < 0.6 ||
    (surface === 'multimodal' && !visualReviewRequired) ||
    (surface === 'static' && visualReviewRequired);
  if (uncertain) reasons.push('uncertain-or-conflicting-assessment');
  const route = uncertain
    ? 'needs-review'
    : surface === 'multimodal' || visualReviewRequired
      ? 'multimodal-review'
      : surface === 'human' || assessment.status !== 'completed'
        ? 'strong-reviewer'
        : risk === 'high' && confidence(assessment, 'risk') >= 0.6
          ? 'strong-reviewer'
          : 'standard-review';
  return { assessment, route, visualReviewRequired, reasons };
}

export async function assessReviewIntake(
  subject: PRRuleSubject,
  signal?: AbortSignal,
  audit?: AssessmentAuditContext,
): Promise<ReviewIntakeAdvisory> {
  if (!audit) return assessReviewIntakeUnrecorded(subject, signal);
  let requestedIdentity;
  try {
    requestedIdentity = assessmentRequestIdentity(reviewIntakeRequest(subject, signal));
  } catch {
    requestedIdentity = undefined;
  } // Invalid optional context is recorded as skipped by assess().
  const result = await monitorAssessment({ ...audit, requestedIdentity }, () =>
    assessReviewIntakeUnrecorded(subject, signal),
  );
  return 'assessment' in result
    ? result
    : {
        assessment: result,
        route: 'needs-review',
        visualReviewRequired: false,
        reasons: ['assessment-unavailable'],
      };
}
