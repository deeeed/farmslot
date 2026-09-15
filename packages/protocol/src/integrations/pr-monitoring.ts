import type {
  MonitoredPRIdentity,
  PRExecutionChoice,
  PRExecutionProfile,
  PRMonitorConfig,
  PRMonitorPolicy,
  PRSlotExecutionChoice,
  PRSlotExecutionProfile,
  PRSourceAccount,
  PRWorkspaceExecutionChoice,
  PRWorkspaceExecutionProfile,
} from '../contracts/pr-monitoring.js';
import { parseNativeProfileReference, sameNativeProfileReference } from '../rpc/native-profile.js';

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
  if ('slotPolicy' in value === 'workspacePolicy' in value) {
    throw new Error('execution must specify exactly one of slotPolicy or workspacePolicy');
  }
  const workspace = 'workspacePolicy' in value;
  fields(
    value,
    workspace
      ? ['workspacePolicy', 'models', 'transport', 'nativeProfile']
      : ['slotPolicy', 'models'],
    'execution',
  );
  if (
    workspace &&
    value.transport !== undefined &&
    value.transport !== 'tmux' &&
    value.transport !== 'native'
  ) {
    throw new Error('execution.transport must be tmux or native');
  }
  const nativeProfile =
    value.nativeProfile === undefined
      ? undefined
      : parseNativeProfileReference(value.nativeProfile);
  if (nativeProfile && value.transport !== 'native') {
    throw new Error('execution.nativeProfile requires native transport');
  }
  const policyPath = workspace ? 'execution.workspacePolicy' : 'execution.slotPolicy';
  const policy = workspace ? value.workspacePolicy : value.slotPolicy;
  record(policy, policyPath);
  const exactField = workspace ? 'machine' : 'slotId';
  const poolField = workspace ? 'allowedMachines' : 'allowedSlots';
  let targets: string[];
  if (policy.kind === 'exact') {
    fields(policy, ['kind', exactField], policyPath);
    const target = policy[exactField];
    text(target, `${policyPath}.${exactField}`);
    targets = [target];
  } else if (policy.kind === 'pool') {
    fields(policy, ['kind', poolField], policyPath);
    const allowed = policy[poolField];
    strings(allowed, `${policyPath}.${poolField}`);
    targets = allowed;
  } else {
    throw new Error(`${policyPath}.kind must be exact or pool`);
  }
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > 20) {
    throw new Error('execution.models must contain 1 to 20 alternatives');
  }
  for (const model of value.models) {
    record(model, 'execution.models[]');
    fields(model, ['runner', 'model', 'effort', poolField], 'execution.models[]');
    text(model.runner, 'model.runner');
    text(model.model, 'model.model');
    if (nativeProfile && nativeProfile.runner !== model.runner) {
      throw new Error('execution.nativeProfile must match every execution model runner');
    }
    if (model.effort !== undefined) text(model.effort, 'model.effort');
    const allowed = model[poolField];
    if (allowed !== undefined) {
      strings(allowed, `model.${poolField}`);
      if (allowed.some((target) => !targets.includes(target))) {
        throw new Error(`model.${poolField} must be within ${policyPath}`);
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

export function assertPRSlotExecutionProfile(
  value: unknown,
): asserts value is PRSlotExecutionProfile {
  assertPRExecutionProfile(value);
  if (isPRWorkspaceExecutionProfile(value)) {
    throw new Error('execution must use a slot policy');
  }
}

export function assertPRMonitorPolicy(value: unknown): asserts value is PRMonitorPolicy {
  record(value, 'policy');
  if (value.mode === 'notify-only') fields(value, ['mode'], 'policy');
  else if (value.mode === 'automatic-repair') {
    fields(value, ['mode', 'execution'], 'policy');
    assertPRSlotExecutionProfile(value.execution);
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
export function prExecutionChoices(profile: PRSlotExecutionProfile): PRSlotExecutionChoice[];
export function prExecutionChoices(
  profile: PRWorkspaceExecutionProfile,
): PRWorkspaceExecutionChoice[];
export function prExecutionChoices(profile: PRExecutionProfile): PRExecutionChoice[];
export function prExecutionChoices(profile: PRExecutionProfile): PRExecutionChoice[] {
  assertPRExecutionProfile(profile);
  if (isPRWorkspaceExecutionProfile(profile)) {
    const machines =
      profile.workspacePolicy.kind === 'exact'
        ? [profile.workspacePolicy.machine]
        : profile.workspacePolicy.allowedMachines;
    return profile.models.flatMap((model) =>
      machines
        .filter((machine) => !model.allowedMachines || model.allowedMachines.includes(machine))
        .map((machine) => ({
          machine,
          runner: model.runner,
          model: model.model,
          effort: model.effort,
          ...(profile.transport === undefined ? {} : { transport: profile.transport }),
          ...(profile.nativeProfile === undefined
            ? {}
            : { nativeProfile: { ...profile.nativeProfile } }),
        })),
    );
  }
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
export function intersectPRExecutionProfiles(
  profiles: PRSlotExecutionProfile[],
): PRSlotExecutionChoice[];
export function intersectPRExecutionProfiles(
  profiles: PRWorkspaceExecutionProfile[],
): PRWorkspaceExecutionChoice[];
export function intersectPRExecutionProfiles(profiles: PRExecutionProfile[]): PRExecutionChoice[];
export function intersectPRExecutionProfiles(profiles: PRExecutionProfile[]): PRExecutionChoice[] {
  const choices = profiles.map(prExecutionChoices);
  return (choices[0] ?? []).filter((choice) =>
    choices.every((other) =>
      other.some(
        (candidate) =>
          (isPRWorkspaceExecutionChoice(choice)
            ? isPRWorkspaceExecutionChoice(candidate) &&
              candidate.machine === choice.machine &&
              (candidate.transport ?? 'tmux') === (choice.transport ?? 'tmux') &&
              sameNativeProfileReference(candidate.nativeProfile, choice.nativeProfile)
            : !isPRWorkspaceExecutionChoice(candidate) && candidate.slotId === choice.slotId) &&
          candidate.runner === choice.runner &&
          candidate.model === choice.model &&
          candidate.effort === choice.effort,
      ),
    ),
  );
}

export function isPRWorkspaceExecutionProfile(
  profile: PRExecutionProfile,
): profile is PRWorkspaceExecutionProfile {
  return profile.workspacePolicy !== undefined;
}

export function isPRWorkspaceExecutionChoice(
  choice: PRExecutionChoice,
): choice is PRWorkspaceExecutionChoice {
  return choice.machine !== undefined;
}
