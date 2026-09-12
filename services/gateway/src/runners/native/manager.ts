import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import type { NativeSessionCreateParams, NativeSessionEnsureParams } from '@farmslot/protocol';

import { KNOWN_RUNNERS } from '../registry.js';

export { NativeSessionManager, resolveNativeExecutable } from '@farmslot/agent-runtime/native';
export function validateNativeRunner(runner: string, model?: string) {
  const definition = KNOWN_RUNNERS[runner];
  if (!definition?.nativeTransport) throw new Error(`Runner has no native transport: ${runner}`);
  if (model && !definition.acceptsModel(model))
    throw new Error('Model is incompatible with this runner');
}
class GatewayNativeSessions extends NativeSessionClient {
  override ensure(owner: string, params: NativeSessionEnsureParams) {
    validateNativeRunner(params.runner, params.model);
    return super.ensure(owner, params);
  }
  override create(owner: string, params: NativeSessionCreateParams) {
    validateNativeRunner(params.runner, params.model);
    return super.create(owner, params);
  }
}
export const nativeSessionManager = new GatewayNativeSessions();
