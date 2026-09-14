import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeSessionCreateParams,
  NativeSessionEnsureParams,
  NativeSessionInfo,
  NativeSessionReadResult,
  NativeSessionResponse,
  NativeSessionSendResult,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { type HostIdentity, type HostRequest, requestHost } from './ipc.js';
import { alive, privateDirectory, readJson } from './storage.js';
import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_INTERRUPT,
  NATIVE_WORKER_METHODS,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESPOND,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_TRANSFER,
  type NativeWorkerCancelResult,
  type NativeWorkerCancelTarget,
  type NativeWorkerLaunch,
  type NativeWorkerResumeParams,
  type NativeWorkerTarget,
} from './worker-launch.js';

/** The same client is usable by gateway and execution-node services. */
export class NativeSessionClient {
  readonly root: string;
  private starting?: Promise<HostIdentity>;
  constructor(
    root = process.env.FARMSLOT_NATIVE_STATE_DIR ?? join(farmslotHome(), 'native-sessions'),
    readonly executionNodeId = 'local',
  ) {
    this.root = resolve(root);
  }
  workerStateDirectory(owner: string, sessionId: string): string {
    return join(this.root, 'workers', createHash('sha256').update(owner).digest('hex'), sessionId);
  }
  prepareWorkerState(owner: string, sessionId: string): string {
    const state = this.workerStateDirectory(owner, sessionId);
    for (const directory of [this.root, join(this.root, 'workers'), resolve(state, '..'), state])
      privateDirectory(directory);
    return state;
  }
  private async host(): Promise<HostIdentity> {
    privateDirectory(this.root);
    const path = join(this.root, 'host.json');
    if (existsSync(path)) {
      const host = readJson<HostIdentity>(path);
      this.assertHostNode(host);
      if (alive(host.pid) && existsSync(join(this.root, 'ready.json')) && existsSync(host.socket))
        return host;
    }
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private assertHostNode(host: HostIdentity) {
    if ((host.executionNodeId ?? 'local') !== this.executionNodeId)
      throw new Error('Native state directory belongs to another execution node');
  }
  private async start(): Promise<HostIdentity> {
    privateDirectory(this.root);
    const source = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(new URL(`./supervisor.${source ? 'ts' : 'js'}`, import.meta.url));
    const args = source
      ? ['--import', import.meta.resolve('tsx'), entry, this.root]
      : [entry, this.root];
    const log = openSync(join(this.root, 'host.log'), 'a', 0o600);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, FARMSLOT_NATIVE_EXECUTION_NODE_ID: this.executionNodeId },
    });
    closeSync(log);
    child.unref();
    let spawnError: Error | undefined;
    child.on('error', (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const path = join(this.root, 'host.json');
      if (existsSync(path)) {
        const host = readJson<HostIdentity>(path);
        this.assertHostNode(host);
        if (alive(host.pid) && existsSync(join(this.root, 'ready.json')) && existsSync(host.socket))
          return host;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Native host unavailable; inspect ${join(this.root, 'host.log')}. No command was retried.`,
    );
  }
  private async call<T>(request: HostRequest): Promise<T> {
    const host = await this.host();
    if (
      'params' in request &&
      'profileId' in request.params &&
      request.params.profileId &&
      !host.supportsProfiles
    )
      throw new Error(
        'Native host upgrade required for account profiles; existing sessions remain available',
      );
    if (
      request.method === NATIVE_WORKER_RESUME &&
      request.params.relocation &&
      !host.supportsWorkerRelocation
    )
      throw new Error('Native host upgrade required for worker relocation');
    if (
      (request.method === NATIVE_WORKER_RESUME ||
        (request.method === NATIVE_WORKER_CANCEL && request.resumeCommandId)) &&
      !host.supportsWorkerResumeFence
    )
      throw new Error('Native host upgrade required for durable worker resume cancellation');
    if (NATIVE_WORKER_METHODS.includes(request.method) && !host.supportsWorkers)
      throw new Error(
        'Native host upgrade required for worker launch configuration; existing sessions remain available',
      );
    if (request.method === 'ensure' && !host.supportsEnsure)
      throw new Error(
        'Native host upgrade required for idempotent creation; existing sessions remain available',
      );
    const result = await requestHost<T>(host, request);
    if ('params' in request && request.params.profileId) {
      const session = result as NativeSessionInfo;
      if (
        session.profileId !== request.params.profileId ||
        session.accountContextId !== request.params.accountContextId
      )
        throw new Error('Native host returned a different account profile binding');
    }
    return result;
  }
  create(owner: string, params: NativeSessionCreateParams) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    return this.call<NativeSessionInfo>({ method: 'create', owner, params });
  }
  ensure(owner: string, params: NativeSessionEnsureParams) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    return this.call<NativeSessionInfo>({ method: 'ensure', owner, params });
  }
  ensureWorker(owner: string, params: NativeSessionEnsureParams, launch: NativeWorkerLaunch) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return this.call<NativeSessionInfo>({ method: NATIVE_WORKER_ENSURE, owner, params, launch });
  }
  resumeWorker(owner: string, params: NativeWorkerResumeParams, launch: NativeWorkerLaunch) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return this.call<NativeSessionInfo>({ method: NATIVE_WORKER_RESUME, owner, params, launch });
  }
  private workerTarget(target: NativeWorkerTarget) {
    if (target.executionNodeId !== undefined && target.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return { id: target.sessionId, generation: target.generation, leaseId: target.leaseId };
  }
  transferWorker(owner: string, target: NativeWorkerTarget, launch: NativeWorkerLaunch) {
    return this.call<NativeSessionInfo>({
      method: NATIVE_WORKER_TRANSFER,
      owner,
      ...this.workerTarget(target),
      launch,
    });
  }
  sendWorker(owner: string, target: NativeWorkerTarget, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({
      method: NATIVE_WORKER_SEND,
      owner,
      ...this.workerTarget(target),
      commandId,
      text,
    });
  }
  closeWorker(owner: string, target: NativeWorkerTarget) {
    return this.call<NativeSessionInfo>({
      method: NATIVE_WORKER_CLOSE,
      owner,
      ...this.workerTarget(target),
    });
  }
  interruptWorker(owner: string, target: NativeWorkerTarget) {
    return this.call<void>({
      method: NATIVE_WORKER_INTERRUPT,
      owner,
      ...this.workerTarget(target),
    });
  }
  cancelWorker(owner: string, target: NativeWorkerCancelTarget) {
    if (target.executionNodeId !== undefined && target.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return this.call<NativeWorkerCancelResult>({
      method: NATIVE_WORKER_CANCEL,
      owner,
      id: target.sessionId,
      generation: target.generation,
      leaseId: target.leaseId,
      sourceLeaseId: target.sourceLeaseId,
      resumeCommandId: target.resumeCommandId,
    });
  }
  respondWorker(
    owner: string,
    target: NativeWorkerTarget,
    requestId: string,
    response: NativeSessionResponse,
  ) {
    return this.call<void>({
      method: NATIVE_WORKER_RESPOND,
      owner,
      ...this.workerTarget(target),
      requestId,
      response,
    });
  }
  list(owner: string) {
    return this.call<NativeSessionInfo[]>({ method: 'list', owner });
  }
  read(owner: string, id: string, after?: number, limit?: number) {
    return this.call<NativeSessionReadResult>({ method: 'read', owner, id, after, limit });
  }
  readWorker(owner: string, id: string, leaseId: string, after?: number, limit?: number) {
    return this.call<NativeSessionReadResult>({
      method: NATIVE_WORKER_READ,
      owner,
      id,
      leaseId,
      after,
      limit,
    });
  }
  send(owner: string, id: string, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({ method: 'send', owner, id, commandId, text });
  }
  respond(owner: string, id: string, requestId: string, response: NativeSessionResponse) {
    return this.call<void>({ method: 'respond', owner, id, requestId, response });
  }
  interrupt(owner: string, id: string) {
    return this.call<void>({ method: 'interrupt', owner, id });
  }
  close(owner: string, id: string) {
    return this.call<void>({ method: 'close', owner, id });
  }
}
