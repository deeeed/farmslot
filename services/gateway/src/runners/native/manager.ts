import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import type { NativeSessionCreateParams } from '@farmslot/protocol';

import { KNOWN_RUNNERS } from '../registry.js';

export { NativeSessionManager, resolveNativeExecutable } from '@farmslot/agent-runtime/native';
class GatewayNativeSessions extends NativeSessionClient {
  override create(owner: string, params: NativeSessionCreateParams) {
    const definition = KNOWN_RUNNERS[params.runner];
    if (!definition?.nativeTransport)
      throw new Error(`Runner has no native transport: ${params.runner}`);
    if (params.model && !definition.acceptsModel(params.model))
      throw new Error('Model is incompatible with this runner');
    return super.create(owner, params);
  }
}
export const nativeSessionManager = new GatewayNativeSessions();
