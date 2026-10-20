import type { ResourceKey } from '@farmslot/protocol/client-cache';
import { Methods } from '@farmslot/protocol/rpc/registry';

import { GatewayMethodError } from '../core/method-error.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import { authorizeGatewayMethod } from '../security/authorization.js';
import type { ClientState } from '../server/client-state.js';

/** Each migrated key uses its read's authorization, including owner scoping when applicable. */
export function canReadResourceKey(
  runtime: GatewayAuthRuntime,
  state: ClientState,
  key: ResourceKey,
): boolean {
  // Only the Sources writer is migrated in the foundation. Other families cannot leak keys.
  if (key.family !== 'sources') return false;
  try {
    authorizeGatewayMethod(runtime, state, Methods.SOURCES_STATUS);
    return true;
  } catch (error) {
    if (
      error instanceof GatewayMethodError &&
      ['AUTH_REQUIRED', 'AUTH_FORBIDDEN'].includes(error.code)
    )
      return false;
    throw error;
  }
}
