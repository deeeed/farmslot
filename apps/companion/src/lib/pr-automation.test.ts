import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRMonitor, PRProjectMonitorPolicy, PRTeamProfile } from '@farmslot/protocol';

import {
  buildPRMonitorConfig,
  buildPRRequest,
  effectivePRRequest,
  newPRExecution,
  newPRMonitorDraft,
  newPRRequestDraft,
  togglePRSlot,
} from './pr-automation';

const execution = { ...newPRExecution(), slotPolicy: { kind: 'exact' as const, slotId: 'slot-a' } };
const team: PRTeamProfile = {
  id: 'team',
  ownerId: 'owner',
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'owner/repo' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    execution,
    review: { sessionIntent: 'resume', scope: 'incremental', validationDepth: 'full-live' },
    repositories: [
      {
        repo: 'owner/repo',
        project: 'project',
        reviewProfile: 'security',
        excludedLabels: [],
        review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' },
      },
    ],
    githubTeams: [],
    notificationPrincipalIds: [],
  },
};

test('requests inherit repository review options and team execution without serializing silent overrides', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/OWNER/REPO/pull/42',
    teamId: team.id,
  };
  const effective = effectivePRRequest(draft, [team]);
  assert.equal(effective.project, 'project');
  assert.equal(effective.review.sessionIntent, 'reset');
  assert.equal(effective.review.validationDepth, 'full-live');
  assert.deepEqual(effective.execution, execution);
  const request = buildPRRequest(draft, 'stable-request');
  assert.equal(request.review, undefined);
  assert.equal(request.execution, undefined);
  assert.equal(request.autoStart, false);
  assert.equal(request.source.client, 'companion');
  assert.deepEqual(Object.keys(request.pr).sort(), ['host', 'number', 'repo']);
});

test('explicit review/QA overrides preserve the selected policy and idempotency key', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    overrideExecution: true,
    execution,
    review: {
      sessionIntent: 'resume' as const,
      scope: 'incremental' as const,
      validationDepth: 'full-live' as const,
    },
  };
  assert.deepEqual(
    buildPRRequest(draft, 'stable-request'),
    buildPRRequest(draft, 'stable-request'),
  );
  assert.equal(buildPRRequest(draft, 'stable-request').review?.validationDepth, 'full-live');
  assert.throws(
    () => buildPRRequest({ ...draft, url: 'https://github.com/owner/repo/issues/42' }, 'key'),
    /pull request URL/,
  );
});

test('editing monitoring preserves principal-bound PR/account/team identity and allows explicit policy changes', () => {
  const config = buildPRMonitorConfig({
    ...newPRMonitorDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    login: 'reader',
  });
  const monitor: PRMonitor = {
    id: 'monitor',
    revision: 3,
    ownerId: 'owner',
    lifecycle: 'active',
    config: { ...config, teamId: 'team' },
    incidents: [],
    originatingRunIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const draft = {
    ...newPRMonitorDraft(monitor),
    url: 'https://github.com/another/repo/pull/1',
    login: 'different-reader',
    automatic: true,
    execution,
    project: 'project',
  };
  const edited = buildPRMonitorConfig(draft, monitor);
  assert.deepEqual(edited.pr, monitor.config.pr);
  assert.deepEqual(edited.account, monitor.config.account);
  assert.equal(edited.teamId, 'team');
  assert.equal(edited.policy.mode, 'automatic-repair');
  assert.throws(() => buildPRMonitorConfig({ ...draft, project: '' }, monitor), /project/);
  assert.throws(
    () => buildPRMonitorConfig({ ...draft, intervalSeconds: '0' }, monitor),
    /pollInterval/,
  );
});

test('slot selection remains bounded when switching between an exact slot and pool', () => {
  const two = togglePRSlot(execution, 'slot-b');
  assert.deepEqual(two.slotPolicy, { kind: 'pool', allowedSlots: ['slot-a', 'slot-b'] });
  assert.deepEqual(togglePRSlot(two, 'slot-a').slotPolicy, { kind: 'exact', slotId: 'slot-b' });
  assert.deepEqual(togglePRSlot(execution, 'slot-a').slotPolicy, {
    kind: 'pool',
    allowedSlots: [],
  });
  assert.deepEqual(two.models, execution.models);
});

test('publication policy edits preserve enterprise hosts and check names containing commas', () => {
  const policy: PRProjectMonitorPolicy = {
    project: 'project',
    ownerId: 'owner',
    revision: 1,
    enabled: false,
    activatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      account: { host: 'git.example.com', login: 'reader' },
      policy: { mode: 'notify-only' },
      watchedChecks: ['test (ubuntu-latest, node-20)', 'lint'],
      pollIntervalMs: 300_000,
      automaticAttemptLimit: 2,
      cooldownMs: 600_000,
    },
  };
  const draft = newPRMonitorDraft(undefined, policy);
  const result = buildPRMonitorConfig({ ...draft, intervalSeconds: '600' }, undefined, true);
  assert.deepEqual(result.account, policy.config.account);
  assert.deepEqual(result.watchedChecks, policy.config.watchedChecks);
  assert.equal(result.pollIntervalMs, 600_000);
});
