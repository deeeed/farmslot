import type {
  MonitoredPRIdentity,
  PRExecutionChoice,
  PRExecutionProfile,
  PRMonitorConfig,
  PRMonitorPolicy,
  PRSourceAccount,
} from '../contracts/pr-monitoring.js';

function record(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function fields(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported`);
  }
}

function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(`${path} must be a non-empty trimmed string of at most 256 characters`);
  }
}

function strings(value: unknown, path: string, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 100) {
    throw new Error(`${path} must be an array with ${allowEmpty ? '0' : '1'} to 100 values`);
  }
  value.forEach((item, index) => text(item, `${path}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${path} contains duplicate values`);
}

function integer(value: unknown, min: number, max: number, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}`);
  }
}

export function assertMonitoredPRIdentity(value: unknown): asserts value is MonitoredPRIdentity {
  record(value, 'pr');
  fields(value, ['host', 'repo', 'number'], 'pr');
  text(value.host, 'pr.host');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value.host) || value.host.includes('..')) {
    throw new Error('pr.host must be a hostname without a port or path');
  }
  text(value.repo, 'pr.repo');
  if (!/^[a-z0-9_-][a-z0-9_.-]*\/[a-z0-9_-][a-z0-9_.-]*$/i.test(value.repo)) {
    throw new Error('pr.repo must be owner/repository');
  }
  integer(value.number, 1, Number.MAX_SAFE_INTEGER, 'pr.number');
}

export function monitoredPRKey(pr: MonitoredPRIdentity): string {
  assertMonitoredPRIdentity(pr);
  return `${pr.host.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

export function monitoredPRUrl(pr: MonitoredPRIdentity): string {
  assertMonitoredPRIdentity(pr);
  return `https://${pr.host.toLowerCase()}/${pr.repo}/pull/${pr.number}`;
}

export function assertPRExecutionProfile(value: unknown): asserts value is PRExecutionProfile {
  record(value, 'execution');
  fields(value, ['slotPolicy', 'models'], 'execution');
  record(value.slotPolicy, 'execution.slotPolicy');
  const policy = value.slotPolicy;
  let slots: string[];
  if (policy.kind === 'exact') {
    fields(policy, ['kind', 'slotId'], 'execution.slotPolicy');
    text(policy.slotId, 'execution.slotPolicy.slotId');
    slots = [policy.slotId];
  } else if (policy.kind === 'pool') {
    fields(policy, ['kind', 'allowedSlots'], 'execution.slotPolicy');
    strings(policy.allowedSlots, 'execution.slotPolicy.allowedSlots');
    slots = policy.allowedSlots;
  } else {
    throw new Error('execution.slotPolicy.kind must be exact or pool');
  }
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > 20) {
    throw new Error('execution.models must contain 1 to 20 alternatives');
  }
  for (const model of value.models) {
    record(model, 'execution.models[]');
    fields(model, ['runner', 'model', 'effort', 'allowedSlots'], 'execution.models[]');
    text(model.runner, 'model.runner');
    text(model.model, 'model.model');
    if (model.effort !== undefined) text(model.effort, 'model.effort');
    if (model.allowedSlots !== undefined) {
      strings(model.allowedSlots, 'model.allowedSlots');
      if (model.allowedSlots.some((slot) => !slots.includes(slot))) {
        throw new Error('model.allowedSlots must be within the execution slot policy');
      }
    }
  }
}

export function assertPRSourceAccount(value: unknown): asserts value is PRSourceAccount {
  record(value, 'account');
  fields(value, ['host', 'login'], 'account');
  text(value.host, 'account.host');
  text(value.login, 'account.login');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value.login))
    throw new Error('account.login must be a GitHub login');
}

export function assertPRMonitorPolicy(value: unknown): asserts value is PRMonitorPolicy {
  record(value, 'policy');
  if (value.mode === 'notify-only') fields(value, ['mode'], 'policy');
  else if (value.mode === 'automatic-repair') {
    fields(value, ['mode', 'execution'], 'policy');
    assertPRExecutionProfile(value.execution);
  } else throw new Error('policy.mode must be notify-only or automatic-repair');
}

export function assertPRMonitorConfig(value: unknown): asserts value is PRMonitorConfig {
  record(value, 'monitor');
  fields(
    value,
    [
      'pr',
      'account',
      'project',
      'teamId',
      'policy',
      'pollIntervalMs',
      'watchedChecks',
      'automaticAttemptLimit',
      'cooldownMs',
    ],
    'monitor',
  );
  assertMonitoredPRIdentity(value.pr);
  assertPRSourceAccount(value.account);
  if (value.account.host.toLowerCase() !== value.pr.host.toLowerCase()) {
    throw new Error('account.host must match the PR host');
  }
  if (value.project !== undefined) text(value.project, 'monitor.project');
  if (value.teamId !== undefined) text(value.teamId, 'monitor.teamId');
  assertPRMonitorPolicy(value.policy);
  if (value.policy.mode === 'automatic-repair') text(value.project, 'monitor.project');
  integer(value.pollIntervalMs, 60_000, 86_400_000, 'monitor.pollIntervalMs');
  strings(value.watchedChecks, 'monitor.watchedChecks', true);
  integer(value.automaticAttemptLimit, 1, 10, 'monitor.automaticAttemptLimit');
  integer(value.cooldownMs, 60_000, 86_400_000, 'monitor.cooldownMs');
}

/** Preserve declared preference order; the queue still owns availability and admission. */
export function prExecutionChoices(profile: PRExecutionProfile): PRExecutionChoice[] {
  assertPRExecutionProfile(profile);
  const slots =
    profile.slotPolicy.kind === 'exact'
      ? [profile.slotPolicy.slotId]
      : profile.slotPolicy.allowedSlots;
  return profile.models.flatMap((model) =>
    slots
      .filter((slot) => !model.allowedSlots || model.allowedSlots.includes(slot))
      .map((slotId) => ({
        slotId,
        runner: model.runner,
        model: model.model,
        effort: model.effort,
      })),
  );
}

/** Overlapping rule constraints intersect; they can never broaden another rule's authority. */
export function intersectPRExecutionProfiles(profiles: PRExecutionProfile[]): PRExecutionChoice[] {
  const choices = profiles.map(prExecutionChoices);
  return (choices[0] ?? []).filter((choice) =>
    choices.every((other) =>
      other.some(
        (candidate) =>
          candidate.slotId === choice.slotId &&
          candidate.runner === choice.runner &&
          candidate.model === choice.model &&
          candidate.effort === choice.effort,
      ),
    ),
  );
}
