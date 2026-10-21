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
  let method: string;
  switch (key.family) {
    case 'sources':
      method = Methods.SOURCES_STATUS;
      break;
    case 'runs':
      method = Methods.RUN_LIST;
      break;
    case 'slots':
    case 'slot':
      method = Methods.FLEET_STATUS;
      break;
    case 'decisions':
    case 'decision':
      method = Methods.DECISION_LIST;
      break;
    case 'family':
      method = Methods.FAMILY_OBSERVABILITY_GET;
      break;
    case 'run':
    case 'gate':
    case 'package':
    case 'review':
    case 'artifacts':
      // These projections belong to the farm run read, which requires admin access.
      method = Methods.RUN_GET;
      break;
    default:
      return false;
  }
  try {
    authorizeGatewayMethod(runtime, state, method);
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
