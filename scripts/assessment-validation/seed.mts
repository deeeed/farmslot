// Startup fixtures for an isolated validation gateway, never the operator store.
import assert from 'node:assert/strict';
import { beginAssessment, finishAssessment } from '../../services/gateway/src/assessment/store.js';
import { reviewIntakeRecommendation } from '../../services/gateway/src/assessment/review-intake.js';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1', 'Explicit fixture opt-in required');
assert.ok(
  process.env.FARMSLOT_HOME?.includes('assessment-proof'),
  'Use a dedicated assessment-proof home',
);
const context = {
  ownerId: 'local-admin',
  consumer: 'review-intake' as const,
  subject: {
    pr: {
      host: 'github.com',
      repo: 'example/assessment-fixture',
      number: 1,
      headSha: 'a'.repeat(40),
    },
  },
  requestedIdentity: {
    provider: 'fixture',
    model: 'fixed',
    inputDigest: 'c'.repeat(64),
    questionSchemaHash: 'b'.repeat(64),
  },
};
const statuses = process.argv.includes('--pagination')
  ? Array.from({ length: 55 }, () => 'completed' as const)
  : (['completed', 'disabled', 'skipped', 'unavailable', 'interrupted'] as const);
for (const status of statuses) {
  const record = await beginAssessment(context);
  if (status === 'interrupted') continue;
  const result =
    status === 'completed'
      ? {
          status,
          provider: 'fixture',
          requestedModel: 'fixed',
          questionSchemaHash: 'b'.repeat(64),
          answers: {
            risk: {
              type: 'choice' as const,
              choice: 'low',
              confidence: 1,
              probabilities: { low: 1 },
            },
            visualReview: { type: 'boolean' as const, probability: 0.53 },
            reviewSurface: {
              type: 'choice' as const,
              choice: 'multimodal',
              confidence: 0.18,
              probabilities: { multimodal: 0.18, static: 0.82 },
            },
          },
          usage: {
            provider: 'fixture',
            requestedModel: 'fixed',
            durationMs: 415,
            inputTokens: 725,
            outputTokens: 99,
          },
        }
      : { status };
  await finishAssessment(record, result, reviewIntakeRecommendation(result));
}
console.log('Synthetic startup fixtures prepared');

if (process.argv.includes('--alias')) {
  const identity = { provider: 'fixture', model: 'latest', questionSchemaHash: 'b'.repeat(64) };
  const audit = {
    ...context,
    requestedIdentity: identity,
    subject: { pr: { ...context.subject.pr, number: 9 } },
  };
  let build = 0;
  for (const status of ['unavailable', 'completed', 'completed'] as const) {
    const record = await beginAssessment(audit);
    const result =
      status === 'completed'
        ? {
            status,
            provider: 'fixture',
            requestedModel: 'latest',
            returnedModel: `fixed-${++build}`,
            questionSchemaHash: identity.questionSchemaHash,
            answers: {
              risk: {
                type: 'choice' as const,
                choice: 'low',
                confidence: 1,
                probabilities: { low: 1 },
              },
            },
            usage: {
              provider: 'fixture',
              requestedModel: 'latest',
              inputTokens: 10,
              outputTokens: 1,
              durationMs: 1,
            },
          }
        : {
            status,
            provider: 'fixture',
            requestedModel: 'latest',
            questionSchemaHash: identity.questionSchemaHash,
          };
    await finishAssessment(record, result, reviewIntakeRecommendation(result));
  }
}
