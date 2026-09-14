import {
  Methods,
  type NativeProfileReference,
  type NativeProfileStatusResult,
  type NativeSessionInfo,
  type NativeWorkerSessionBinding,
  type Run,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { poolDir, type SlotVars } from '../../core/config.js';
import { isLocal } from '../../core/exec.js';
import { loadPoolConfigs } from '../../fleet/state.js';

import { routeNativeExecution } from './node.js';

export function nativeWorkerProfileForRunner(run: Run, runner: string) {
  if (run.nativeProfile?.runner === runner) return run.nativeProfile;
  // A retained primary can inherit a configuration without a new requested selection.
  // Fresh reviewers using that runner should retain the effective configuration too.
  const inherited = selectAgentContext(run, { role: 'primary' })?.nativeSession?.profile;
  return inherited?.runner === runner ? inherited : undefined;
}

export function assertNativeProfileSlot(profile: NativeProfileReference, vars: SlotVars): void {
  const executionNodeId = isLocal(vars.host, vars.machine) ? 'local' : vars.machine;
  if (profile.executionNodeId !== executionNodeId)
    throw new Error('Selected native profile belongs to another execution node');
}

export async function nativeProfileAllowedSlots(
  profile: NativeProfileReference,
  allowedSlots?: string[],
): Promise<string[]> {
  const pools = await loadPoolConfigs(poolDir);
  const slots = pools
    .filter(
      (pool) =>
        (isLocal(pool.host, pool.machine) ? 'local' : pool.machine) === profile.executionNodeId,
    )
    .flatMap((pool) => pool.slots.map((slot) => slot.id))
    .filter((slot) => !allowedSlots || allowedSlots.includes(slot));
  if (!slots.length)
    throw new Error('No eligible slots belong to the selected native profile node');
  return slots;
}

export function nativeWorkerProfileMatches(
  info: Pick<NativeSessionInfo, 'profileId' | 'accountContextId' | 'runner' | 'executionNodeId'>,
  binding: Pick<NativeWorkerSessionBinding, 'profile'>,
): boolean {
  return (
    info.profileId === binding.profile?.profileId &&
    (!binding.profile ||
      (info.accountContextId === binding.profile.accountContextId &&
        info.runner === binding.profile.runner &&
        info.executionNodeId === binding.profile.executionNodeId))
  );
}

/** Observe only native login metadata; the execution node retains credentials and configuration. */
export async function inspectNativeWorkerProfile(
  owner: string,
  profile: NativeProfileReference,
): Promise<void> {
  const result = (await routeNativeExecution(owner, Methods.NATIVE_PROFILE_STATUS, {
    executionNodeId: profile.executionNodeId,
    profileId: profile.profileId,
  })) as NativeProfileStatusResult;
  if (
    result.profile.id !== profile.profileId ||
    result.profile.runner !== profile.runner ||
    result.profile.accountContextId !== profile.accountContextId
  )
    throw new Error('Selected native profile changed; select its current configuration');
  if (!result.account.installed || result.account.login !== 'authenticated')
    throw new Error('Selected native profile is not signed in on its execution node');
}
