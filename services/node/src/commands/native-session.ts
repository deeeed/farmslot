import path from 'node:path';

import { NATIVE_WORKER_METHODS, NativeSessionClient } from '@farmslot/agent-runtime/native';
import {
  releasedSessionsPolicy,
  withNativeHostRefreshPolicy,
} from '@farmslot/agent-runtime/native/client';
import { NATIVE_NODE_REFRESH_MAX_RUNNERS } from '@farmslot/agent-runtime/native/host-runtime';
import { isNativeHostUnavailableError } from '@farmslot/agent-runtime/native/host-unavailable';
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
import {
  NATIVE_SESSION_ARCHIVE,
  NATIVE_SESSION_ARCHIVE_LIMIT,
  type NativeConversationCursor,
  type NativeConversationUpdate,
  type NativeExecutionNodeDeclaration,
  type NativeNodeSessionEnvelope,
} from '@farmslot/protocol';
import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

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
        supportsHostRefresh: true,
        supportsSessionArchive: true,
        ...{ supportsObservations: true },
      };
    }
    // Only fenced idle stops, few enough to finish within the gateway's launch timeout.
    this.client = new NativeSessionClient(
      path.join(root, 'nodes', encodeURIComponent(machine)),
      machine,
      undefined,
      { maxRunners: NATIVE_NODE_REFRESH_MAX_RUNNERS },
    );
  }

  /** Before registration, refresh only a fully stopped host; a busy host keeps its sessions. */
  async prepareRuntime(): Promise<void> {
    if (!this.declaration) return;
    try {
      await this.client.warm();
    } catch (error) {
      if (isNativeHostUnavailableError(error)) {
        // The host did not become ready in time. Register anyway: each launch starts or waits
        // for the host itself, and the node must not exit over it.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`Native host not ready at node start; registering without it. ${reason}`);
        return;
      }
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'NATIVE_HOST_VERSION_SKEW'
      )
        throw error;
      // Keep reads and cleanup available. New admissions are refused until a launch carrying
      // the gateway's release list finds every live session idle and released, or a later
      // node start finds every runner stopped; never kill a busy reviewer to deploy.
      console.warn(error.message);
    }
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
  private trustedExecutables: Record<string, string> = {};
  private trustedExecutablesDigest = '{}';

  private resolveTrustedExecutable(runner: string): string | undefined {
    const candidate = this.trustedExecutables[runner];
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  }

  private normalizeTrustedExecutables(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized: Record<string, string> = {};
    for (const [runner, executable] of Object.entries(value as Record<string, unknown>)) {
      if (typeof executable === 'string' && executable.trim()) {
        normalized[runner] = executable.trim();
      }
    }
    return normalized;
  }

  /** Called once by the daemon transport owner, never by an RPC or panel. */
  async startObservation(publish: (receipt: NativeSourceReceipt) => void): Promise<void> {
    if (!this.declaration) return;
    this.observation?.stop();
    this.observation = new NativeHostObservation(
      this.client,
      this.declaration.ownerPrincipalId,
      publish,
      undefined,
      undefined,
      (runner) => this.resolveTrustedExecutable(runner),
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

  /** Apply trusted runner executables at the observation owner before admitting profile reads. */
  async configureObservation(value: Record<string, unknown>): Promise<NativeSourceReceipt> {
    if (!this.declaration || value.owner !== this.declaration.ownerPrincipalId)
      throw Object.assign(new Error('Native profile is not owned by this principal'), {
        code: 'AUTH_FORBIDDEN',
      });
    if (!this.observation)
      throw Object.assign(new Error('Native source unsupported'), {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
      });
    const next = this.normalizeTrustedExecutables(value.executables);
    const nextDigest = JSON.stringify(
      Object.keys(next)
        .sort()
        .map((key) => [key, next[key]]),
    );
    this.trustedExecutables = next;
    this.trustedExecutablesDigest = nextDigest;
    if (!this.observation.current().ready) {
      await this.observation.setExecutableConfig(nextDigest);
      await this.observation.retry();
      return this.observation.current();
    }
    return this.observation.setExecutableConfig(nextDigest);
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
        return this.observation!.profileStatus(params.profileId);
      }
      return this.route(value);
    });
  }

  /** Run retention's archive request; it never starts or refreshes the host. */
  private archive(value: Partial<Record<keyof NativeNodeSessionEnvelope, unknown>>) {
    const ids = (value.params as { sessionIds?: unknown } | undefined)?.sessionIds;
    if (
      value.hostRelease !== undefined ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > NATIVE_SESSION_ARCHIVE_LIMIT ||
      !ids.every((id) => typeof id === 'string')
    )
      throw Object.assign(
        new Error(`sessionIds must list 1-${NATIVE_SESSION_ARCHIVE_LIMIT} session IDs`),
        { code: 'INVALID_PARAMS' },
      );
    return this.client.archiveSessions(this.declaration!.ownerPrincipalId, ids as string[]);
  }

  /** The gateway's `native.session` request; its fields are checked here. */
  async route(value: Partial<Record<keyof NativeNodeSessionEnvelope, unknown>>): Promise<unknown> {
    if (!this.declaration || value.owner !== this.declaration.ownerPrincipalId)
      throw Object.assign(new Error('Native profile is not owned by this principal'), {
        code: 'AUTH_FORBIDDEN',
      });
    if (typeof value.method !== 'string')
      throw Object.assign(new Error('Native method is required'), { code: 'INVALID_PARAMS' });
    const owner = this.declaration.ownerPrincipalId;
    const method = value.method;
    if (method === NATIVE_SESSION_ARCHIVE) return this.archive(value);
    const executable =
      typeof value.executable === 'string' && value.executable.trim()
        ? value.executable.trim()
        : undefined;
    const executables =
      value.executables &&
      typeof value.executables === 'object' &&
      !Array.isArray(value.executables)
        ? (value.executables as Record<string, unknown>)
        : undefined;
    const resolveExecutable =
      executable || executables
        ? (runner: string) => {
            if (executable) return executable;
            const candidate = executables?.[runner];
            return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
          }
        : undefined;
    const route = () =>
      NATIVE_WORKER_METHODS.includes(method)
        ? routeNativeWorkerSession(this.client, owner, method, value.params)
        : routeNativeSession(
            this.client,
            owner,
            method,
            value.params,
            parseNativeSessionRequester(value.requester),
            executable || resolveExecutable ? { executable, resolveExecutable } : undefined,
          );
    if (value.hostRelease === undefined) return route();
    if (
      !Array.isArray(value.hostRelease) ||
      !value.hostRelease.every((id) => typeof id === 'string')
    )
      throw Object.assign(new Error('hostRelease must be a list of session IDs'), {
        code: 'INVALID_PARAMS',
      });
    // A launch to a host on another runtime refreshes it, stopping only released idle sessions.
    return withNativeHostRefreshPolicy(
      releasedSessionsPolicy(owner, new Set(value.hostRelease)),
      route,
    );
  }
}
