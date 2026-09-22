import type {
  AssessmentJsonValue,
  AssessmentResult,
  PRRuleSubject,
  ReviewIntakeAdvisory,
} from '@farmslot/protocol';

import { assess } from './index.js';

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
  return String(value);
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
export async function assessReviewIntake(subject: PRRuleSubject): Promise<ReviewIntakeAdvisory> {
  const allowedFactKeys = new Set([
    'repository',
    'author',
    'state',
    'draft',
    'base-branch',
    'head-branch',
    'labels',
    'changed-paths',
  ]);
  const facts = Object.fromEntries(
    Object.entries(subject.facts).filter(([key]) => allowedFactKeys.has(key)),
  );
  const assessment = await assess({
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
  });
  const risk = choice(assessment, 'risk');
  const visualReviewRequired = booleanProbability(assessment, 'visualReview') >= 0.65;
  const surface = choice(assessment, 'reviewSurface');
  const reasons: string[] = [];
  if (risk === 'high') reasons.push('assessment-risk-high');
  if (visualReviewRequired) reasons.push('assessment-visual-review-required');
  if (surface === 'human') reasons.push('assessment-uncertain-routing');
  const route =
    surface === 'multimodal' || visualReviewRequired
      ? 'multimodal-review'
      : surface === 'human' || assessment.status !== 'completed'
        ? 'strong-reviewer'
        : risk === 'high' && confidence(assessment, 'risk') >= 0.6
          ? 'strong-reviewer'
          : 'standard-review';
  return { assessment, route, visualReviewRequired, reasons };
}
