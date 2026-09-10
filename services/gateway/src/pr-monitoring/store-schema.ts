import Ajv from 'ajv';

import {
  assertPRExecutionProfile,
  assertPRMonitorConfig,
  monitoredPRKey,
} from '@farmslot/protocol';

import type { PRMonitorStoreData } from './store.js';

const timestamp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
};
const text = { type: 'string', minLength: 1 };
const counter = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const signal = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'revision', 'kind', 'summary', 'url'],
  properties: {
    key: text,
    revision: text,
    kind: { enum: ['review', 'feedback', 'check', 'conflict'] },
    summary: text,
    url: text,
    checkName: text,
  },
};

const ajv = new Ajv();
const validate = ajv.compile<PRMonitorStoreData>({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'revision', 'monitors'],
  properties: {
    version: { const: 1 },
    revision: counter,
    projectPolicies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'ownerId',
          'project',
          'revision',
          'enabled',
          'activatedAt',
          'updatedAt',
          'config',
        ],
        properties: {
          ownerId: text,
          project: text,
          revision: { ...counter, minimum: 1 },
          enabled: { type: 'boolean' },
          activatedAt: timestamp,
          updatedAt: timestamp,
          config: { type: 'object' },
        },
      },
    },
    publicationEnrollments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ownerId', 'project', 'runId', 'prKey', 'monitorId'],
        properties: { ownerId: text, project: text, runId: text, prKey: text, monitorId: text },
      },
    },
    monitors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'revision',
          'ownerId',
          'config',
          'lifecycle',
          'createdAt',
          'updatedAt',
          'originatingRunIds',
          'incidents',
        ],
        properties: {
          id: text,
          revision: { ...counter, minimum: 1 },
          observationGeneration: counter,
          ownerId: text,
          config: { type: 'object' },
          lifecycle: { enum: ['active', 'paused', 'stopped', 'finished'] },
          createdAt: timestamp,
          updatedAt: timestamp,
          originatingRunIds: { type: 'array', uniqueItems: true, items: text },
          observationError: text,
          nextCheckAt: timestamp,
          observation: {
            type: 'object',
            additionalProperties: false,
            required: [
              'checkedAt',
              'headSha',
              'title',
              'author',
              'state',
              'draft',
              'mergeability',
              'reviewDecision',
              'signals',
            ],
            properties: {
              checkedAt: timestamp,
              headSha: text,
              title: text,
              author: text,
              state: { enum: ['open', 'closed', 'merged'] },
              draft: { type: 'boolean' },
              mergeability: { enum: ['mergeable', 'conflicting', 'unknown'] },
              reviewDecision: {
                enum: ['approved', 'changes-requested', 'review-required', 'unknown'],
              },
              signals: { type: 'array', items: signal },
              checks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'name', 'status', 'url'],
                  properties: {
                    key: text,
                    name: text,
                    url: text,
                    status: {
                      enum: ['passed', 'failed', 'pending', 'cancelled', 'skipped', 'unknown'],
                    },
                  },
                },
              },
              repairAccess: {
                type: 'object',
                additionalProperties: false,
                required: ['allowed'],
                properties: {
                  allowed: { type: 'boolean' },
                  reason: text,
                  headRepository: text,
                  headBranch: text,
                },
              },
            },
          },
          incidents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'signal', 'firstObservedAt', 'lastObservedAt', 'attemptCount'],
              properties: {
                id: text,
                signal,
                firstObservedAt: timestamp,
                lastObservedAt: timestamp,
                resolvedAt: timestamp,
                acknowledgedAt: timestamp,
                snoozedUntil: timestamp,
                handledAt: timestamp,
                attemptCount: counter,
                repairChainId: text,
                repairChainClosedAt: timestamp,
                queueItemId: text,
                runId: text,
                waitingReason: text,
                resumeCondition: text,
                lastAttemptAt: timestamp,
              },
            },
          },
          repairs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'id',
                'mode',
                'state',
                'project',
                'execution',
                'headSha',
                'incidentIds',
                'createdAt',
              ],
              properties: {
                id: text,
                mode: { enum: ['automatic', 'manual'] },
                state: {
                  enum: ['pending', 'queued', 'running', 'blocked', 'finished', 'cancelled'],
                },
                project: text,
                execution: { type: 'object' },
                headSha: text,
                incidentIds: { type: 'array', items: text, minItems: 1, uniqueItems: true },
                createdAt: timestamp,
                completedAt: timestamp,
                queueItemId: text,
                runId: text,
                waitingReason: text,
                nextAdmissionAt: timestamp,
              },
            },
          },
        },
      },
    },
    recoveryBoundaries: { type: 'object', additionalProperties: { type: 'string' } },
  },
});

export function decodeMonitorStore(value: unknown): PRMonitorStoreData {
  if (!validate(value)) {
    throw new Error(`Invalid PR monitor store: ${ajv.errorsText(validate.errors)}`);
  }
  const ids = new Set<string>();
  const policies = new Set<string>();
  for (const policy of value.projectPolicies ?? []) {
    assertPRMonitorConfig({
      ...policy.config,
      project: policy.project,
      pr: { host: policy.config.account?.host, repo: 'validation/validation', number: 1 },
    });
    const key = JSON.stringify([policy.ownerId, policy.project]);
    if (policies.has(key)) throw new Error('Duplicate project monitoring policy');
    policies.add(key);
  }
  const subscriptions = new Set<string>();
  for (const monitor of value.monitors) {
    assertPRMonitorConfig(monitor.config);
    const repairIds = new Set<string>();
    for (const repair of monitor.repairs ?? []) {
      assertPRExecutionProfile(repair.execution);
      if (
        repairIds.has(repair.id) ||
        repair.incidentIds.some((id) => !monitor.incidents.some((incident) => incident.id === id))
      )
        throw new Error('Invalid repair request identity or incident reference');
      repairIds.add(repair.id);
    }
    const config = monitor.config;
    const key = JSON.stringify([
      monitoredPRKey(config.pr),
      monitor.ownerId,
      config.teamId ?? null,
      config.account.host.toLowerCase(),
      config.account.login.toLowerCase(),
    ]);
    if (ids.has(monitor.id) || subscriptions.has(key))
      throw new Error('Duplicate PR monitor identity');
    ids.add(monitor.id);
    subscriptions.add(key);
    if (
      new Set(monitor.incidents.map((incident) => incident.id)).size !== monitor.incidents.length
    ) {
      throw new Error('Duplicate PR monitor incident identity');
    }
  }
  const enrollments = new Set<string>();
  for (const entry of value.publicationEnrollments ?? []) {
    const key = JSON.stringify([entry.ownerId, entry.project, entry.runId, entry.prKey]);
    if (
      enrollments.has(key) ||
      !value.monitors.some(
        (monitor) =>
          monitor.id === entry.monitorId &&
          monitor.ownerId === entry.ownerId &&
          monitoredPRKey(monitor.config.pr) === entry.prKey,
      )
    )
      throw new Error('Invalid publication enrollment receipt');
    enrollments.add(key);
  }
  return value;
}
