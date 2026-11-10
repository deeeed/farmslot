import type { PoolConfig } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { poolConfigId } from '../fleet/machine-pool.js';

type ReviewEnabledPool = PoolConfig & {
  reviewWorkspaces: NonNullable<PoolConfig['reviewWorkspaces']>;
};

export function resolveReviewWorkspacePool(
  pools: readonly PoolConfig[],
  machine: string,
  project: string,
): ReviewEnabledPool {
  const matches = pools.filter(
    (pool): pool is ReviewEnabledPool =>
      pool.machine === machine &&
      Boolean(pool.reviewWorkspaces) &&
      (pool.project === project || pool.slots.some((slot) => slot.project === project)),
  );
  if (matches.length === 0) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      `Machine ${machine} has no pool with review workspace capacity configured for project ${project}`,
    );
  }
  if (matches.length !== 1) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      `Review machine ${machine} must resolve to exactly one pool configuration for project ${project}; matching pools: ${matches.map(poolConfigId).join(', ')}`,
    );
  }
  return matches[0];
}
