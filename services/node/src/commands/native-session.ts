import path from 'node:path';

import { NATIVE_WORKER_METHODS, NativeSessionClient } from '@farmslot/agent-runtime/native';
import {
  NativeHostObservation,
  type NativeSourceReceipt,
} from '@farmslot/agent-runtime/native/observation';
import { validateNativeProfileParams } from '@farmslot/agent-runtime/native/profile-service';
import { routeNativeSession } from '@farmslot/agent-runtime/native/service';
import { routeNativeWorkerSession } from '@farmslot/agent-runtime/native/worker-service';
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
      this.declaration = {
        ownerPrincipalId: owner.trim(),
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
    );
  }
}
