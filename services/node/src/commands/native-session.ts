import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import path from 'node:path';

import { NATIVE_WORKER_METHODS, NativeSessionClient } from '@farmslot/agent-runtime/native';
import {
  NativeHostObservation,
  type NativeSourceReceipt,
} from '@farmslot/agent-runtime/native/observation';
import { validateNativeProfileParams } from '@farmslot/agent-runtime/native/profile-service';
import {
  parseNativeSessionRequester,
  routeNativeSession,
} from '@farmslot/agent-runtime/native/service';
import { routeNativeWorkerSession } from '@farmslot/agent-runtime/native/worker-service';
import type {
  NativeConversationCursor,
  NativeConversationUpdate,
  NativeExecutionNodeDeclaration,
} from '@farmslot/protocol';

/** The daemon owns routing; its detached native host survives daemon/gateway disconnects. */
export class NativeNodeSessions {
  readonly declaration?: NativeExecutionNodeDeclaration;
  private readonly client: NativeSessionClient;

  constructor(
    machine: string,
    owner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID,
    root = currentFarmPaths('node').state.nativeSessions,
  ) {
    if (owner?.trim()) {
      if (!machine || machine === 'local')
        throw new Error('Native execution requires a distinct node machine ID');
      this.declaration = {
        ownerPrincipalId: owner.trim(),
        supportsStandaloneDelegation: true,
        supportsApprovalMode: true,
        conversationStreaming: 1,
        supportsEnsure: true,
        supportsWorkers: true,
        supportsWorkerStopAttestation: true,
        supportsStructuredResults: true,
        supportsProfiles: true,
        ...{ supportsObservations: true },
      };
    }
    this.client = new NativeSessionClient(
      path.join(root, 'nodes', encodeURIComponent(machine)),
      machine,
    );
  }

  /** Public target metadata only; never starts a host or exposes its IPC credential. */
  metadata(owner: string) {
    if (!this.declaration || owner !== this.declaration.ownerPrincipalId)
      throw Object.assign(new Error('Native profile is not owned by this principal'), {
        code: 'AUTH_FORBIDDEN',
      });
    return this.client.metadata();
  }

  private streams = new Map<
    string,
    | import('@farmslot/agent-runtime/native/conversation-ipc').NativeConversationConnection
    | undefined
  >();
  private streamEpoch = 0;
  async subscribe(
    id: string,
    owner: string,
    sessionId: string,
    after: NativeConversationCursor | undefined,
    publish: (update: NativeConversationUpdate) => void,
    leaseId?: string,
    generation?: string,
  ) {
    if (!this.declaration || owner !== this.declaration.ownerPrincipalId || this.streams.has(id))
      throw new Error('Invalid native conversation source');
    const epoch = this.streamEpoch;
    this.streams.set(id, undefined);
    try {
      const stream = await this.client.subscribe(
        owner,
        sessionId,
        after,
        publish,
        leaseId,
        generation,
      );
      if (epoch !== this.streamEpoch || !this.streams.has(id)) {
        stream.stop();
        throw new Error('Native conversation connection closed during subscribe');
      }
      this.streams.set(id, stream);
      return stream;
    } catch (error) {
      if (epoch === this.streamEpoch) this.streams.delete(id);
      throw error;
    }
  }
  unsubscribe(id: string): void {
    this.streams.get(id)?.stop();
    this.streams.delete(id);
  }
  stopStreams(): void {
    this.streamEpoch++;
    for (const stream of this.streams.values()) stream?.stop();
    this.streams.clear();
  }

  private observation?: NativeHostObservation;

  /** Called once by the daemon transport owner, never by an RPC or panel. */
  async startObservation(publish: (receipt: NativeSourceReceipt) => void): Promise<void> {
    if (!this.declaration) return;
    this.observation?.stop();
    this.observation = new NativeHostObservation(
      this.client,
      this.declaration.ownerPrincipalId,
      publish,
    );
    await this.observation.start();
  }

  stopObservation(): void {
    this.stopStreams();
    this.observation?.stop();
  }
  observationReceipt(): NativeSourceReceipt | undefined {
    return this.observation?.current();
  }

  /** Internal envelope only for marked reads; commands retain the original one-attempt route. */
  async routeObserved(value: Record<string, unknown>): Promise<unknown> {
    if (!this.declaration || value.owner !== this.declaration.ownerPrincipalId)
      throw Object.assign(new Error('Native profile is not owned by this principal'), {
        code: 'AUTH_FORBIDDEN',
      });
    const reads: readonly string[] = [
      'native.session.read',
      'native.session.list',
      'native.profile.list',
      'native.profile.status',
      'native.worker.read',
    ];
    if (!reads.includes(String(value.method)))
      throw Object.assign(new Error('Native observation is read-only'), { code: 'INVALID_PARAMS' });
    if (!this.observation)
      throw Object.assign(new Error('Native source unsupported'), {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
      });
    if (!this.observation.current().ready) await this.observation.retry();
    return this.observation.read(() => {
      if (value.method === 'native.profile.status') {
        const params = value.params as { profileId?: unknown };
        if (
          !params ||
          typeof params !== 'object' ||
          Array.isArray(params) ||
          typeof params.profileId !== 'string' ||
          !params.profileId.trim()
        )
          throw Object.assign(new Error('Native profile ID required'), { code: 'INVALID_PARAMS' });
        validateNativeProfileParams(params);
        return Promise.resolve(this.observation!.profileStatus(params.profileId));
      }
      return this.route(value);
    });
  }

  async route(value: Record<string, unknown>): Promise<unknown> {
    if (!this.declaration || value.owner !== this.declaration.ownerPrincipalId)
      throw Object.assign(new Error('Native profile is not owned by this principal'), {
        code: 'AUTH_FORBIDDEN',
      });
    if (typeof value.method !== 'string')
      throw Object.assign(new Error('Native method is required'), { code: 'INVALID_PARAMS' });
    if (NATIVE_WORKER_METHODS.includes(value.method))
      return routeNativeWorkerSession(
        this.client,
        this.declaration.ownerPrincipalId,
        value.method,
        value.params,
      );
    return routeNativeSession(
      this.client,
      this.declaration.ownerPrincipalId,
      value.method,
      value.params,
      parseNativeSessionRequester(value.requester),
    );
  }
}
