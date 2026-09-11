import Ajv from 'ajv';

import {
  assertMonitoredPRIdentity,
  assertPRExecutionProfile,
  assertPRMonitorPolicy,
  assertPRReviewOptions,
  assertPRReviewRequest,
  assertPRSourceAccount,
  assertPRTeamConfig,
  assertPRTriggerRuleConfig,
} from '@farmslot/protocol';

import type { PRRuleStoreData } from './store.js';

const text = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: text };
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const timestamp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
};
const reviewObservation = {
  type: 'object',
  additionalProperties: false,
  required: [
    'observedAt',
    'headSha',
    'state',
    'draft',
    'decision',
    'reviewer',
    'requested',
    'review',
  ],
  properties: {
    observedAt: timestamp,
    headSha: text,
    state: { enum: ['open', 'closed', 'merged'] },
    draft: { type: 'boolean' },
    decision: { type: ['string', 'null'] },
    reviewer: text,
    requested: { type: 'boolean' },
    review: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['state', 'commit', 'submittedAt'],
          properties: {
            state: text,
            commit: { type: ['string', 'null'] },
            submittedAt: { type: ['string', 'null'] },
          },
        },
      ],
    },
  },
};
const common = {
  id: text,
  ownerId: text,
  revision,
  config: { type: 'object' },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const commonRequired = Object.keys(common);
const ajv = new Ajv();
const validate = ajv.compile<PRRuleStoreData>({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'teams', 'rules', 'intents'],
  properties: {
    version: { const: 1 },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kind',
          'ownerId',
          'ruleId',
          'ruleRevision',
          'ruleName',
          'teamId',
          'teamRevision',
          'teamName',
          'account',
          'subject',
          'sourceRevision',
          'reasons',
          'current',
          'status',
          'acknowledgedBy',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: text,
          kind: { enum: ['notify', 'monitor'] },
          requiresFreshValidation: { type: 'boolean' },
          nextValidationAt: timestamp,
          ownerId: text,
          ruleId: text,
          ruleRevision: revision,
          ruleName: text,
          teamId: text,
          teamRevision: revision,
          teamName: text,
          account: { type: 'object' },
          subject: {
            type: 'object',
            additionalProperties: false,
            required: ['pr', 'headSha', 'title', 'observedAt', 'facts'],
            properties: {
              pr: { type: 'object' },
              headSha: text,
              title: { type: 'string' },
              observedAt: timestamp,
              facts: { type: 'object' },
              sourceReasons: strings,
              reviewObservation,
              reviewPolicyFacts: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  approvalCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                  providerReviewDecision: text,
                  lastActivityAt: {
                    type: 'string',
                    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$',
                  },
                },
              },
            },
          },
          sourceRevision: text,
          reasons: strings,
          project: text,
          monitorPolicy: {
            type: 'object',
            additionalProperties: false,
            required: ['mode'],
            properties: {
              mode: { enum: ['notify-only', 'automatic-repair'] },
              execution: { type: 'object' },
            },
          },
          monitorPollIntervalMs: { type: 'integer', minimum: 60_000, maximum: 86_400_000 },
          current: { type: 'boolean' },
          status: { enum: ['pending', 'applied', 'withdrawn'] },
          monitorId: text,
          error: text,
          acknowledgedBy: { type: 'object', additionalProperties: timestamp },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    },
    submissions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'ownerId', 'revision', 'request', 'createdAt', 'updatedAt'],
        properties: {
          id: text,
          ownerId: text,
          revision,
          request: { type: 'object' },
          intentId: text,
          priorExecutionIds: { type: 'array', items: text, uniqueItems: true },
          checkedAt: timestamp,
          cancelledAt: timestamp,
          error: text,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    },
    teams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: commonRequired,
        properties: common,
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...commonRequired, 'enabled', 'scan'],
        properties: {
          ...common,
          enabled: { type: 'boolean' },
          scan: {
            type: 'object',
            additionalProperties: false,
            required: ['baselinePending', 'backfillRequested', 'subjects'],
            properties: {
              sourceProgress: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'id',
                  'startedAt',
                  'pages',
                  'items',
                  'pendingConnections',
                  'requestsThisAttempt',
                  'resumed',
                ],
                properties: {
                  id: text,
                  startedAt: timestamp,
                  oldestObservationAt: timestamp,
                  completedAt: timestamp,
                  pages: { type: 'integer', minimum: 0 },
                  items: { type: 'integer', minimum: 0 },
                  pendingConnections: { type: 'integer', minimum: 0 },
                  requestsThisAttempt: { type: 'integer', minimum: 0 },
                  resumed: { type: 'boolean' },
                  nextAttemptAt: timestamp,
                },
              },
              baselinePending: { type: 'boolean' },
              rebasePending: { type: 'boolean' },
              backfillRequested: { type: 'boolean' },
              checkedAt: timestamp,
              nextScanAt: timestamp,
              error: text,
              admissionWarning: text,
              subjects: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['revision', 'matched', 'admitted'],
                  properties: {
                    revision: text,
                    matched: { type: 'boolean' },
                    admitted: { type: 'boolean' },
                    admittedActions: {
                      type: 'array',
                      uniqueItems: true,
                      items: { enum: ['review', 'notify', 'monitor'] },
                    },
                    actionIds: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { notify: text, monitor: text },
                    },
                    deferredActions: {
                      type: 'array',
                      uniqueItems: true,
                      items: { enum: ['review', 'notify', 'monitor'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    intents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'pr',
          'headSha',
          'reviewProfile',
          'status',
          'contributions',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: text,
          round: revision,
          title: { type: 'string' },
          author: text,
          pr: { type: 'object' },
          headSha: text,
          reviewProfile: text,
          status: {
            enum: [
              'held',
              'needs-configuration',
              'queued',
              'running',
              'completed',
              'failed',
              'withdrawn',
            ],
          },
          createdAt: timestamp,
          updatedAt: timestamp,
          waitingReason: text,
          queueItemId: text,
          runId: text,
          reviewedSha: text,
          dispatchHold: text,
          contributions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'teamId',
                'teamRevision',
                'ownerId',
                'reasons',
                'autoStart',
                'eligible',
                'configurationErrors',
              ],
              oneOf: [
                { required: ['ruleId', 'ruleRevision'], not: { required: ['submissionId'] } },
                { required: ['submissionId', 'submissionRevision'], not: { required: ['ruleId'] } },
              ],
              properties: {
                ruleId: text,
                ruleRevision: revision,
                submissionId: text,
                submissionRevision: revision,
                teamId: text,
                teamRevision: revision,
                ownerId: text,
                reasons: strings,
                project: text,
                execution: { type: 'object' },
                review: { type: 'object' },
                reviewObservation,
                autoStart: { type: 'boolean' },
                eligible: { type: 'boolean' },
                configurationErrors: strings,
                acceptedAt: timestamp,
                deferredAt: timestamp,
              },
            },
          },
        },
      },
    },
  },
});

export function decodePRRuleStore(value: unknown): PRRuleStoreData {
  if (!validate(value))
    throw new Error(`Invalid PR rule store: ${ajv.errorsText(validate.errors)}`);
  for (const records of [
    value.teams,
    value.rules,
    value.intents,
    value.submissions ?? [],
    value.actions ?? [],
  ])
    if (new Set(records.map((item) => item.id)).size !== records.length)
      throw new Error('Duplicate PR rule store record identity');
  for (const team of value.teams) assertPRTeamConfig(team.config);
  for (const action of value.actions ?? []) {
    assertMonitoredPRIdentity(action.subject.pr);
    assertPRSourceAccount(action.account);
    if (action.account.host.toLowerCase() !== action.subject.pr.host.toLowerCase())
      throw new Error('Action account host does not match the PR');
    if (action.monitorPolicy) assertPRMonitorPolicy(action.monitorPolicy);
    if (
      !value.rules.some(
        (rule) =>
          rule.id === action.ruleId &&
          rule.ownerId === action.ownerId &&
          rule.config.teamId === action.teamId,
      )
    )
      throw new Error('Action references an unavailable rule');
    if (
      (action.kind === 'monitor') !== !!action.monitorPolicy ||
      (action.kind === 'notify' && action.status !== 'applied' && !action.requiresFreshValidation)
    )
      throw new Error('Invalid rule action policy or status');
  }
  const requestKeys = new Set<string>();
  for (const submission of value.submissions ?? []) {
    assertPRReviewRequest(submission.request);
    const key = JSON.stringify([submission.ownerId, submission.request.idempotencyKey]);
    if (requestKeys.has(key)) throw new Error('Duplicate review request idempotency key');
    requestKeys.add(key);
    if (
      !value.teams.some(
        (team) => team.id === submission.request.teamId && team.ownerId === submission.ownerId,
      )
    )
      throw new Error('Review request references an unavailable team');
  }
  for (const rule of value.rules) {
    assertPRTriggerRuleConfig(rule.config);
    if (
      !value.teams.some((team) => team.id === rule.config.teamId && team.ownerId === rule.ownerId)
    )
      throw new Error('Rule references an unavailable team');
  }
  for (const intent of value.intents) {
    assertMonitoredPRIdentity(intent.pr);
    if (
      new Set(
        intent.contributions.map((item) =>
          item.ruleId !== undefined ? `rule:${item.ruleId}` : `submission:${item.submissionId}`,
        ),
      ).size !== intent.contributions.length
    )
      throw new Error('Duplicate review contribution');
    for (const source of intent.contributions) {
      if (source.execution) assertPRExecutionProfile(source.execution);
      if (source.review) assertPRReviewOptions(source.review);
      if (source.submissionId !== undefined) {
        if (
          !value.submissions?.some(
            (item) =>
              item.id === source.submissionId &&
              item.ownerId === source.ownerId &&
              item.request.teamId === source.teamId,
          )
        )
          throw new Error('Review contribution references an unavailable request');
        continue;
      }
      if (
        !value.rules.some(
          (rule) =>
            rule.id === source.ruleId &&
            rule.ownerId === source.ownerId &&
            rule.config.teamId === source.teamId,
        )
      )
        throw new Error('Review contribution references an unavailable rule');
    }
  }
  return value;
}
