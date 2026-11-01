import {
  NativeSessionClient,
  type NativeWorkerLaunch,
  type NativeWorkerResumeParams,
} from '@farmslot/agent-runtime/native';
import type { NativeSessionCreateParams, NativeSessionEnsureParams } from '@farmslot/protocol';

import { assertNativeRunner, KNOWN_RUNNERS } from '../registry.js';

export { NativeSessionManager, resolveNativeExecutable } from '@farmslot/agent-runtime/native';
export function validateNativeRunner(runner: string, model?: string) {
  assertNativeRunner(runner);
  if (model && !KNOWN_RUNNERS[runner].acceptsModel(model))
    throw new Error('Model is incompatible with this runner');
}
class GatewayNativeSessions extends NativeSessionClient {
  override ensureWorker(
    owner: string,
    params: NativeSessionEnsureParams,
    launch: NativeWorkerLaunch,
  ) {
    validateNativeRunner(params.runner, params.model);
    return super.ensureWorker(owner, params, launch);
  }
  override resumeWorker(
    owner: string,
    params: NativeWorkerResumeParams,
    launch: NativeWorkerLaunch,
  ) {
    validateNativeRunner(params.runner, params.model);
    return super.resumeWorker(owner, params, launch);
  }
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
