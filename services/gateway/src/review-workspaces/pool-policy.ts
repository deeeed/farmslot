import {
  bindPRExecutionProfileToPool,
  isUnboundWorkspacePool,
  type PRExecutionProfile,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { loadPoolConfigs } from '../fleet/state.js';

/** Bind at admission so a queued portable policy sees the current configured registry. */
export async function bindPRExecutionProfilesToPool(
  profiles: PRExecutionProfile[],
): Promise<PRExecutionProfile[]> {
  if (!profiles.some(isUnboundWorkspacePool)) return profiles;
  const machines = (await loadPoolConfigs()).map((pool) => pool.machine);
  try {
    return profiles.map((profile) => bindPRExecutionProfileToPool(profile, machines));
  } catch (error) {
    // Shape was already validated; pool authority failures need an operator configuration fix.
    throw new GatewayMethodError('REVIEW_WORKSPACE_NEEDS_CONFIGURATION', (error as Error).message);
  }
}
