import {
  intersectPRExecutionProfiles,
  isPRWorkspaceExecutionChoice,
  type PRExecutionChoice,
  type PRExecutionProfile,
  type PRSlotExecutionChoice,
  type PRSlotExecutionProfile,
  type PRSourceAccount,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { isNodeTransportUnavailableError } from '../fleet/node-rpc.js';
import { loadFleetStatus, loadProjectConfig } from '../fleet/state.js';
import { inspectReviewWorkspaceTarget } from '../review-workspaces/admission.js';
import { isKnownRunner, runnerSupportsEffort, runnerSupportsModel } from '../runners/registry.js';

export interface PRExecutionContext {
  ownerId: string;
}

export function resolvePRExecution(
  project: string,
  repo: string,
  profiles: PRSlotExecutionProfile[],
  context?: PRExecutionContext,
): Promise<{ choices: PRSlotExecutionChoice[]; errors: string[] }>;
export function resolvePRExecution(
  project: string,
  repo: string,
  profiles: PRExecutionProfile[],
  context?: PRExecutionContext,
): Promise<{ choices: PRExecutionChoice[]; errors: string[] }>;
export async function resolvePRExecution(
  project: string,
  repo: string,
  profiles: PRExecutionProfile[],
  context?: PRExecutionContext,
): Promise<{ choices: PRExecutionChoice[]; errors: string[] }> {
  const config = await loadProjectConfig(project);
  if (!config || config.ci.repo.toLowerCase() !== repo.toLowerCase())
    return { choices: [], errors: ['Project does not map to the PR repository'] };
  const choices = intersectPRExecutionProfiles(profiles);
  if (!choices.length)
    return {
      choices: [],
      errors: ['Execution target/model/effort constraints have no common execution choice'],
    };
  if (choices.some(isPRWorkspaceExecutionChoice)) {
    if (!context?.ownerId)
      return { choices: [], errors: ['Workspace review requires an execution owner'] };
    const supported: PRExecutionChoice[] = [];
    const errors: string[] = [];
    for (const choice of choices) {
      if (!isPRWorkspaceExecutionChoice(choice)) continue;
      try {
        await inspectReviewWorkspaceTarget({ project, ...choice }, context.ownerId);
        supported.push(choice);
      } catch (error) {
        // Rejected alternatives become operator-visible configuration failures; unexpected failures propagate.
        if (!(error instanceof GatewayMethodError) && !isNodeTransportUnavailableError(error))
          throw error;
        errors.push(`${choice.machine}: ${error.message}`);
      }
    }
    return { choices: supported, errors: supported.length ? [] : errors };
  }
  const fleet = await loadFleetStatus();
  const errors: string[] = [];
  const supported = choices.filter((choice) => {
    const slot = fleet.slots.find((item) => item.slot === choice.slotId);
    if (!slot || slot.missingFromPool || slot.project !== project) {
      errors.push(`${choice.slotId}: slot is missing or belongs to another project`);
      return false;
    }
    if (
      !isKnownRunner(choice.runner) ||
      choice.model === 'unknown' ||
      !runnerSupportsModel(choice.runner, choice.model)
    ) {
      errors.push(`${choice.runner}/${choice.model}: unsupported runner or model`);
      return false;
    }
    if (!runnerSupportsEffort(choice.runner, choice.model, choice.effort)) {
      errors.push(`${choice.runner}/${choice.model}: unsupported effort ${choice.effort}`);
      return false;
    }
    return true;
  });
  return { choices: supported, errors: supported.length ? [] : errors };
}

export function assertPRRepairExecutionAccess(
  expectedLogin: string,
  viewer: unknown,
  repository: unknown,
  branch: unknown,
): void {
  if (
    !viewer ||
    typeof viewer !== 'object' ||
    !('login' in viewer) ||
    typeof viewer.login !== 'string' ||
    viewer.login.toLowerCase() !== expectedLogin.toLowerCase()
  )
    throw new Error('Slot GitHub identity does not match the selected monitoring account');
  const permissions =
    repository && typeof repository === 'object' && 'permissions' in repository
      ? repository.permissions
      : undefined;
  if (
    !permissions ||
    typeof permissions !== 'object' ||
    !('push' in permissions) ||
    permissions.push !== true
  )
    throw new Error('Slot GitHub credentials do not grant repository push permission');
  if (
    !branch ||
    typeof branch !== 'object' ||
    !('protected' in branch) ||
    branch.protected !== false
  )
    throw new Error('Protected or unknown head-branch policy requires operator-managed repair');
}

/** Read through the selected slot's existing credentials; never send gateway tokens to a worker. */
export async function verifyPRRepairExecution(
  slotId: string,
  account: PRSourceAccount,
  repo: string,
  branch: string,
): Promise<void> {
  const vars = await loadSlotVars(slotId);
  const command = (endpoint: string) =>
    `cd ${shellQuote(vars.remoteRepo)} && env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN gh api --hostname ${shellQuote(account.host)} ${shellQuote(endpoint)}`;
  const [viewer, repository, head] = await Promise.all([
    execOnSlot(vars, command('user'), { timeout: 15_000 }),
    execOnSlot(vars, command(`repos/${repo}`), { timeout: 15_000 }),
    execOnSlot(vars, command(`repos/${repo}/branches/${encodeURIComponent(branch)}`), {
      timeout: 15_000,
    }),
  ]);
  if ([viewer, repository, head].some((result) => result.exitCode !== 0))
    throw new Error('Slot GitHub access probe failed; verify its account and branch access');
  assertPRRepairExecutionAccess(
    account.login,
    JSON.parse(viewer.stdout),
    JSON.parse(repository.stdout),
    JSON.parse(head.stdout),
  );
}
