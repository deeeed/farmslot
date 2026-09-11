import type {
  PRReviewOptions,
  PRReviewRequest,
  PRTeamConfig,
  PRTriggerRuleConfig,
} from '../contracts/pr-rules.js';

import { assertMonitoredPRIdentity, assertPRExecutionProfile } from './pr-monitoring.js';
import { assertPRImportedProjectView, parsePRProjectURL } from './pr-project-import.js';
import { assertPRRulePredicate } from './pr-rule-predicates.js';

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`Unsupported property: ${unsupported}`);
}
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256)
    throw new Error(`${name} must be a non-empty trimmed string of at most 256 characters`);
}
function list(value: unknown, name: string, minimum = 0): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100)
    throw new Error(`${name} must have ${minimum} to 100 entries`);
}
function texts(value: unknown, name: string): asserts value is string[] {
  list(value, name);
  value.forEach((item) => text(item, name));
  if (new Set(value).size !== value.length) throw new Error(`${name} has duplicate values`);
}
function integer(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
}

export function assertPRReviewOptions(value: unknown): asserts value is PRReviewOptions {
  record(value, 'review options');
  keys(value, ['sessionIntent', 'scope', 'validationDepth', 'busySession']);
  if (value.sessionIntent !== 'resume' && value.sessionIntent !== 'reset')
    throw new Error('Review session must be Continue or Fresh');
  if (value.scope !== 'incremental' && value.scope !== 'full')
    throw new Error('Review scope must be incremental or full');
  if (value.validationDepth !== 'static-code' && value.validationDepth !== 'full-live')
    throw new Error('Review validation must be static-code or full-live');
  if (
    value.busySession !== undefined &&
    value.busySession !== 'wait' &&
    value.busySession !== 'fresh'
  )
    throw new Error('Busy reviewer policy must be wait or fresh');
}

export function assertPRReviewRequest(value: unknown): asserts value is PRReviewRequest {
  record(value, 'review request');
  keys(value, ['teamId', 'pr', 'idempotencyKey', 'autoStart', 'execution', 'review', 'source']);
  text(value.teamId, 'teamId');
  text(value.idempotencyKey, 'idempotencyKey');
  assertMonitoredPRIdentity(value.pr);
  if (typeof value.autoStart !== 'boolean') throw new Error('Review autoStart must be explicit');
  if (value.execution !== undefined) assertPRExecutionProfile(value.execution);
  if (value.review !== undefined) assertPRReviewOptions(value.review);
  record(value.source, 'review source');
  keys(value.source, ['client', 'reference', 'requester']);
  text(value.source.client, 'source.client');
  if (value.source.reference !== undefined) text(value.source.reference, 'source.reference');
  if (value.source.requester !== undefined) text(value.source.requester, 'source.requester');
}

export function assertPRTeamConfig(value: unknown): asserts value is PRTeamConfig {
  record(value, 'team');
  keys(value, [
    'name',
    'account',
    'sources',
    'predicate',
    'repositories',
    'execution',
    'review',
    'githubTeams',
    'notificationPrincipalIds',
  ]);
  text(value.name, 'team.name');
  record(value.account, 'team.account');
  keys(value.account, ['host', 'login']);
  text(value.account.host, 'account.host');
  text(value.account.login, 'account.login');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value.account.login))
    throw new Error('Invalid GitHub account login');
  assertMonitoredPRIdentity({ host: value.account.host, repo: 'validation/validation', number: 1 });
  list(value.sources, 'sources', 1);
  for (const source of value.sources) {
    record(source, 'source');
    if (source.kind === 'repository') {
      keys(source, ['kind', 'repo']);
      assertMonitoredPRIdentity({ host: value.account.host, repo: source.repo, number: 1 });
    } else if (source.kind === 'github-project') {
      keys(source, ['kind', 'projectId', 'label', 'url', 'importedView']);
      text(source.projectId, 'projectId');
      text(source.label, 'source.label');
      if (source.importedView !== undefined) assertPRImportedProjectView(source.importedView);
      if (source.url !== undefined) {
        if (
          typeof source.url !== 'string' ||
          source.url.length > 2048 ||
          parsePRProjectURL(source.url, value.account.host).viewNumber !== undefined
        )
          throw new Error('Project source URL must identify the Project itself');
      }
    } else throw new Error('Unsupported PR source kind');
  }
  if (
    new Set(
      value.sources.map((source) => {
        const item = source as Record<string, unknown>;
        return JSON.stringify(
          item.kind === 'repository'
            ? ['repository', String(item.repo).toLowerCase()]
            : [
                'github-project',
                item.projectId,
                (item.importedView as { number: number } | undefined)?.number ?? null,
              ],
        );
      }),
    ).size !== value.sources.length
  )
    throw new Error('Duplicate PR sources');
  assertPRRulePredicate(value.predicate);
  list(value.repositories, 'repositories');
  const repos = new Set<string>();
  for (const policy of value.repositories) {
    record(policy, 'repository policy');
    keys(policy, [
      'repo',
      'project',
      'reviewProfile',
      'execution',
      'review',
      'excludedLabels',
      'approvalTarget',
      'staleAfterDays',
    ]);
    assertMonitoredPRIdentity({ host: value.account.host, repo: policy.repo, number: 1 });
    const repo = String(policy.repo).toLowerCase();
    if (repos.has(repo)) throw new Error('Duplicate repository policy');
    repos.add(repo);
    if (policy.project !== undefined) text(policy.project, 'project');
    text(policy.reviewProfile, 'reviewProfile');
    texts(policy.excludedLabels, 'excludedLabels');
    if (policy.execution !== undefined) assertPRExecutionProfile(policy.execution);
    if (policy.review !== undefined) assertPRReviewOptions(policy.review);
    if (policy.approvalTarget !== undefined)
      integer(policy.approvalTarget, 'approvalTarget', 0, 100);
    if (policy.staleAfterDays !== undefined)
      integer(policy.staleAfterDays, 'staleAfterDays', 1, 365);
  }
  if (value.execution !== undefined) assertPRExecutionProfile(value.execution);
  if (value.review !== undefined) assertPRReviewOptions(value.review);
  texts(value.githubTeams, 'githubTeams');
  for (const team of value.githubTeams)
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(team))
      throw new Error('GitHub teams must use org/team-slug');
  texts(value.notificationPrincipalIds, 'notificationPrincipalIds');
}

export function assertPRTriggerRuleConfig(value: unknown): asserts value is PRTriggerRuleConfig {
  record(value, 'rule');
  keys(value, [
    'name',
    'teamId',
    'predicate',
    'actions',
    'pollIntervalMs',
    'maxAdmissionsPerScan',
    'rereviewOnHeadChange',
  ]);
  text(value.name, 'rule.name');
  text(value.teamId, 'rule.teamId');
  assertPRRulePredicate(value.predicate);
  list(value.actions, 'actions', 1);
  const kinds = new Set<string>();
  for (const action of value.actions) {
    record(action, 'action');
    if (typeof action.kind !== 'string' || kinds.has(action.kind))
      throw new Error('Duplicate or invalid rule action');
    kinds.add(action.kind);
    if (action.kind === 'notify') keys(action, ['kind']);
    else if (action.kind === 'review') {
      keys(action, ['kind', 'autoStart', 'execution', 'review']);
      if (typeof action.autoStart !== 'boolean')
        throw new Error('Review autoStart must be explicit');
      if (action.execution !== undefined) assertPRExecutionProfile(action.execution);
      if (action.review !== undefined) assertPRReviewOptions(action.review);
    } else if (action.kind === 'monitor') {
      keys(action, ['kind', 'policy', 'pollIntervalMs']);
      if (action.pollIntervalMs !== undefined)
        integer(action.pollIntervalMs, 'monitor.pollIntervalMs', 60_000, 86_400_000);
      record(action.policy, 'monitor policy');
      if (action.policy.mode === 'notify-only') keys(action.policy, ['mode']);
      else if (action.policy.mode === 'automatic-repair') {
        keys(action.policy, ['mode', 'execution']);
        assertPRExecutionProfile(action.policy.execution);
      } else throw new Error('Unsupported monitor policy');
    } else throw new Error('Unsupported rule action');
  }
  integer(value.pollIntervalMs, 'pollIntervalMs', 60_000, 86_400_000);
  integer(value.maxAdmissionsPerScan, 'maxAdmissionsPerScan', 1, 100);
  if (typeof value.rereviewOnHeadChange !== 'boolean')
    throw new Error('rereviewOnHeadChange must be explicit');
}
