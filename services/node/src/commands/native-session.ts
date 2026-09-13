import path from 'node:path';

import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import { routeNativeSession } from '@farmslot/agent-runtime/native/service';
import type { NativeExecutionNodeDeclaration } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

/** The daemon owns routing; its detached native host survives daemon/gateway disconnects. */
export class NativeNodeSessions {
  readonly declaration?: NativeExecutionNodeDeclaration;
  private readonly client: NativeSessionClient;

  constructor(
    machine: string,
    owner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID,
    root = process.env.FARMSLOT_NATIVE_STATE_DIR ?? path.join(farmslotHome(), 'native-sessions'),
  ) {
    if (owner?.trim()) {
      if (!machine || machine === 'local')
        throw new Error('Native execution requires a distinct node machine ID');
      this.declaration = { ownerPrincipalId: owner.trim(), supportsEnsure: true };
    }
    this.client = new NativeSessionClient(
      path.join(root, 'nodes', encodeURIComponent(machine)),
      machine,
    );
  }

  async route(value: Record<string, unknown>): Promise<unknown> {
    if (!this.declaration || value.owner !== this.declaration.ownerPrincipalId)
      throw Object.assign(new Error('Native profile is not owned by this principal'), {
        code: 'AUTH_FORBIDDEN',
      });
    if (typeof value.method !== 'string')
      throw Object.assign(new Error('Native method is required'), { code: 'INVALID_PARAMS' });
    return routeNativeSession(
      this.client,
      this.declaration.ownerPrincipalId,
      value.method,
      value.params,
    );
  }
}
