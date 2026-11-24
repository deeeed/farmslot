import {
  NativeSessionClient,
  type NativeWorkerLaunch,
  type NativeWorkerResumeParams,
} from '@farmslot/agent-runtime/native';
import type {
  NativeSessionCreateParams,
  NativeSessionEnsureParams,
  NativeSessionRequester,
} from '@farmslot/protocol';

import { assertNativeRunner, KNOWN_RUNNERS, runnerSupportsEffort } from '../registry.js';

import { gatewayNativeRefreshPolicy } from './host-refresh.js';

export { NativeSessionManager, resolveNativeExecutable } from '@farmslot/agent-runtime/native';
export function validateNativeRunner(runner: string, model?: string, effort?: string) {
  assertNativeRunner(runner);
  if (model && !KNOWN_RUNNERS[runner].acceptsModel(model))
    throw new Error('Model is incompatible with this runner');
  if (
    effort !== undefined &&
    !runnerSupportsEffort(runner, model ?? KNOWN_RUNNERS[runner].defaultModel ?? '', effort)
  )
    throw new Error('Effort is incompatible with this runner and model');
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
  override ensure(
    owner: string,
    params: NativeSessionEnsureParams,
    requester?: NativeSessionRequester,
  ) {
    validateNativeRunner(params.runner, params.model, params.effort);
    return super.ensure(owner, params, requester);
  }
  override create(
    owner: string,
    params: NativeSessionCreateParams,
    requester?: NativeSessionRequester,
  ) {
    validateNativeRunner(params.runner, params.model, params.effort);
    return super.create(owner, params, requester);
  }
}
export const nativeSessionManager = new GatewayNativeSessions();
// A host left on an older runtime by a deploy refreshes once its live sessions are idle,
// except those an active run would need a person to resume.
nativeSessionManager.setRefreshPolicy(gatewayNativeRefreshPolicy);
