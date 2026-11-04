import type { PoolConfig } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

type ReviewEnabledPool = PoolConfig & {
  reviewWorkspaces: NonNullable<PoolConfig['reviewWorkspaces']>;
};

export function resolveReviewWorkspacePool(
  pools: readonly PoolConfig[],
  machine: string,
): ReviewEnabledPool {
  const matches = pools.filter(
    (pool): pool is ReviewEnabledPool => pool.machine === machine && Boolean(pool.reviewWorkspaces),
  );
  if (matches.length === 0) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      `Machine ${machine} has no pool with review workspace capacity configured`,
    );
  }
  if (matches.length !== 1) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      'Review machine must resolve to exactly one pool configuration',
    );
  }
  return matches[0];
}
