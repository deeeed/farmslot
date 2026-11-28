import { AsyncLocalStorage } from 'node:async_hooks';

import type { NativeSessionClient } from '@farmslot/agent-runtime/native';
import {
  assertNativeSourceCurrent,
  canonicalTrustedExecutablesDigest,
  EMPTY_TRUSTED_EXECUTABLES_DIGEST,
  NativeHostObservation,
  type NativeSourceReceipt,
  NativeSourceUnavailable,
} from '@farmslot/agent-runtime/native/observation';
import type {
  NativeExecutionNodeDeclaration,
  NativeSessionInfo,
  Principal,
} from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import type { SlotPools } from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import {
  indexMachinePoolSnapshot,
  type MachinePoolSnapshot,
  readMachinePoolSnapshot,
} from '../fleet/machine-pool-snapshot.js';
import { getNode } from '../fleet/machine-registry.js';
import { isNodeTransportUnavailableError, sendNodeRequest } from '../fleet/node-rpc.js';
import { nativeSessionManager } from '../runners/native/manager.js';
import {
  resolveNativeExecutionNode,
  resolveTrustedNativeExecutablesFromIndex,
} from '../runners/native/node.js';
import { authorizeNativeWorkerHistory } from '../runners/native/worker-history.js';
import { normalizeRunner } from '../runners/registry.js';
import {
  type NativeCatalogPreferenceLease,
  observeNativeCatalogPreferences,
  observeVisibleModelPreferences,
  visibleModelPreferenceChanges,
} from '../runners/visible-models.js';
import { readCredentialStoreSnapshot } from '../security/credential-store.js';
import { isGenerationZeroPrincipal, nativeOwnerAssignedMachines } from '../security/native-node.js';
import {
  hasNativeWorkspaceAccess,
  nativeOwnerCanUseWorkers,
  ownsLocalNativeProfile,
  requireNativeSessionOwner,
} from '../security/native-owner.js';
import {
  isStandaloneAdmin,
  standaloneOwner,
  standaloneOwners,
} from '../security/native-standalone.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import {
  changedNativeCatalogKeys,
  type NativeCatalogChange,
  nativeCatalogChanges,
  type NativeCatalogSourceReceipt,
  NativeCatalogSourceUnavailable,
} from './native-catalog-changes.js';
import { publishNativeSessionChange } from './native-session-changes.js';
import { resourceRevisions } from './revisions.js';

/** Matches the parent's explicit private collection/detail union. No wildcard identities. */
export type NativeObservationKey =
  | { family: 'native-session' | 'profiles'; scope: 'owner'; ownerId: string }
  | {
      family: 'native-session';
      nodeId: string;
      ownerId: string;
      sessionId?: string;
      workerId?: string;
    }
  | { family: 'profiles'; nodeId: string; ownerId: string };

export interface NativeInterest {
  key: NativeObservationKey;
  method: string;
  /** Original route params, including exact worker pin, but never persisted as query identity. */
  params: Record<string, unknown>;
  session?: NativeSessionInfo;
}
interface NativeObservedContext {
  /** Only cross-node inventory uses partial admission. Targeted reads remain strict. */
  admitted?: ReadonlySet<string>;
}
const observedRead = new AsyncLocalStorage<NativeObservedContext>();
/** Called before a collection route touches a host, including the local detached host. */
export function admitNativeCollectionNode(nodeId: string): void {
  const admitted = observedRead.getStore()?.admitted;
  if (admitted && !admitted.has(nodeId)) throw new NativeSourceUnavailable();
}
interface NativeCollectionMetadata {
  assignments: string;
  nodes: Map<string, { connection: object | undefined; metadata: string }>;
}
function collectionMetadata(
  ownerId: string,
  nodes: readonly string[],
  owners?: Readonly<Record<string, string>>,
): NativeCollectionMetadata {
  const store = readCredentialStoreSnapshot();
  const issued = store.principals.filter(
    (p) =>
      p.subject.type === 'node' &&
      p.subject.nativeOwnerPrincipalId === (owners?.[p.subject.machine] ?? ownerId),
  );
  // Private in-memory equality only. No credential secrets or foreign owner data is retained.
  const assignments = JSON.stringify(
    issued.map((p) => ({
      id: p.id,
      generation: p.generation,
      subject: p.subject,
      credentials: store.credentials
        .filter((c) => c.principalId === p.id)
        .map((c) => ({ id: c.id, revokedAt: c.revokedAt })),
    })),
  );
  return {
    assignments,
    nodes: new Map(
      nodes.map((id) => {
        const node = id === 'local' ? undefined : getNode(id);
        return [
          id,
          {
            connection: node?.ws,
            metadata: JSON.stringify({
              local: id === 'local' ? ownsLocalNativeProfile(owners?.[id] ?? ownerId) : undefined,
              ownerGeneration:
                store.principals.find((p) => p.id === (owners?.[id] ?? ownerId))?.generation ?? 0,
              declaration: node?.nativeSessions,
              principalId: node?.nativeAuthority?.principalId,
              valid: node?.nativeAuthority?.valid(),
              state: node?.ws.readyState,
            }),
          },
        ];
      }),
    ),
  };
}
function sameCollectionMetadata(a: NativeCollectionMetadata, b: NativeCollectionMetadata): boolean {
  return (
    a.assignments === b.assignments &&
    a.nodes.size === b.nodes.size &&
    [...a.nodes].every(
      ([id, entry]) =>
        entry.connection === b.nodes.get(id)?.connection &&
        entry.metadata === b.nodes.get(id)?.metadata,
    )
  );
}
export function isNativeObservedRead(): boolean {
  return observedRead.getStore() !== undefined;
}

export interface NativeReadAuthority {
  ownerId: string;
  nodes: string[];
  owners?: Readonly<Record<string, string>>;
}
const authorityGuards = new WeakMap<NativeReadAuthority, () => void>();
/** Recheck a captured target at the synchronous frame-delivery boundary. */
export function assertNativeObservationAuthority(authority: NativeReadAuthority): void {
  authorityGuards.get(authority)?.();
}
function sourceOwner(authority: NativeReadAuthority, node: string): string {
  return authority.owners?.[node] ?? authority.ownerId;
}

function supportsNativeSource(authority: NativeReadAuthority, node: string): boolean {
  const registered = node === 'local' ? undefined : getNode(node);
  const validOwner =
    !authority.owners ||
    isGenerationZeroPrincipal(
      readCredentialStoreSnapshot().principals,
      sourceOwner(authority, node),
    );
  return (
    validOwner &&
    (node === 'local' ||
      (registered?.nativeSessions?.ownerPrincipalId === sourceOwner(authority, node) &&
        (registered.nativeSessions as { supportsObservations?: boolean }).supportsObservations ===
          true))
  );
}

/** Used unchanged for read admission, stamping and event/key filtering. Authentication is resolved
 * afresh by the connection owner; neither params nor a saved owner field grants authority. */
export async function authorizeNativeObservation(
  reader: Principal,
  interest: NativeInterest,
): Promise<NativeReadAuthority> {
  if (reader.subject.type === 'node' || interest.key.ownerId !== reader.id)
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native reader identity changed');
  return runWithSessionOriginator(reader, async () => {
    const key = interest.key;
    if ('scope' in key) {
      if (
        interest.params.worker !== undefined ||
        interest.params.sessionId !== undefined ||
        interest.params.executionNodeId !== undefined
      )
        throw new GatewayMethodError('INVALID_PARAMS', 'Native collection target mismatch');
      if (isStandaloneAdmin(reader)) {
        const owners = Object.fromEntries(standaloneOwners(reader));
        return { ownerId: reader.id, nodes: Object.keys(owners), owners };
      }
      const ownerId = requireNativeSessionOwner();
      if (!hasNativeWorkspaceAccess(reader, readCredentialStoreSnapshot().principals))
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native owner view is unavailable');
      const nodes = [
        ...nativeOwnerAssignedMachines(readCredentialStoreSnapshot().principals, ownerId),
      ];
      if (ownsLocalNativeProfile(ownerId)) nodes.push('local');
      return { ownerId, nodes: [...new Set(nodes)] };
    }
    if (
      key.nodeId !== (interest.params.executionNodeId ?? 'local') ||
      (key.family === 'native-session' && key.sessionId !== interest.params.sessionId)
    )
      throw new GatewayMethodError('INVALID_PARAMS', 'Native resource target mismatch');
    if (interest.params.worker !== undefined) {
      if (!nativeOwnerCanUseWorkers(reader))
        throw new GatewayMethodError(
          'AUTH_FORBIDDEN',
          'Native worker supervision authority changed',
        );
      if (key.family !== 'native-session' || !key.workerId)
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Pinned native history key required');
      const worker = await authorizeNativeWorkerHistory(interest.method, interest.params);
      const { binding } = worker;
      const target = interest.params.worker as { runId?: string };
      if (
        target.runId !== key.workerId ||
        binding.sessionId !== key.sessionId ||
        binding.executionNodeId !== key.nodeId ||
        (interest.session &&
          (interest.session.ownerPrincipalId !== binding.ownerPrincipalId ||
            interest.session.workerLeaseId !== binding.leaseId))
      )
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native history binding changed');
      const ownerId = binding.ownerPrincipalId;
      const authority = { ownerId, nodes: [binding.executionNodeId] };
      authorityGuards.set(authority, () =>
        runWithSessionOriginator(reader, () => {
          if (worker.revalidate().binding.ownerPrincipalId !== ownerId)
            throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native worker owner changed');
        }),
      );
      return authority;
    }
    const ownerId = isStandaloneAdmin(reader)
      ? standaloneOwner(reader, key.nodeId)
      : requireNativeSessionOwner();
    if (key.nodeId === 'local') {
      if (!ownsLocalNativeProfile(ownerId))
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native local profile is unavailable');
    } else resolveNativeExecutionNode(ownerId, key.nodeId);
    if (key.family === 'native-session' && key.sessionId && interest.session) {
      if (
        interest.session.workerManaged ||
        interest.session.ownerPrincipalId !== ownerId ||
        interest.session.executionNodeId !== key.nodeId ||
        interest.session.id !== key.sessionId ||
        key.workerId
      )
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native session identity changed');
    }
    const authority = { ownerId, nodes: [key.nodeId] };
    authorityGuards.set(authority, () =>
      runWithSessionOriginator(reader, () => {
        const currentOwner = isStandaloneAdmin(reader)
          ? standaloneOwner(reader, key.nodeId)
          : requireNativeSessionOwner();
        if (
          currentOwner !== ownerId ||
          (key.nodeId === 'local' && !ownsLocalNativeProfile(ownerId))
        )
          throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native target ownership changed');
        if (key.nodeId !== 'local') resolveNativeExecutionNode(ownerId, key.nodeId);
      }),
    );
    return authority;
  });
}

interface NativeConnection {
  /** Invalidation hint only; publication always reauthorizes the actual reader. */
  standaloneAdmin?: boolean;
  /** Must re-resolve the CURRENT authenticated session, including revocation and generation. */
  principal: () => Principal;
  interests: Map<string, NativeInterest>;
  catalogPreferences?: NativeCatalogPreferenceLease;
  catalogInterest?: NativeInterest;
  catalogReader?: { id: string; generation: number };
  visiblePreferences?: NativeCatalogPreferenceLease;
  visibleReader?: { id: string; generation: number };
}
type SourceDesiredConfig =
  | {
      readonly kind: 'valid';
      readonly digest: string;
      readonly executables: Record<string, string> | undefined;
    }
  | { readonly kind: 'error'; readonly error: string };

interface SourceConfigState {
  /** Monotonic per-source epoch bumped on every effective change to desired state (including B -> ambiguous -> B). */
  epoch: number;
  desired?: SourceDesiredConfig;
  committedEpoch: number;
  committedDigest?: string;
  configuring?: {
    readonly epoch: number;
    readonly digest: string;
    readonly promise: Promise<void>;
  };
  error?: string;
  /** True when `error` came from a persistent pool-resolution failure rather than a transient sync failure. */
  errorIsPoolResolution?: boolean;
  /** Epoch for which a source-pushed `profiles` notice was held while `configuring` was active. */
  heldProfileNoticeEpoch?: number;
}

interface AdmittedProfileEpoch {
  readonly epoch: number;
  readonly digest: string;
}

function createSourceConfigState(): SourceConfigState {
  return { epoch: 0, committedEpoch: -1 };
}

interface RemoteSource {
  connection: object;
  current: () => boolean;
  receipt: NativeSourceReceipt;
  readonly supportsObservationConfiguration: boolean;
  readonly config: SourceConfigState;
}
interface RegisteredExecutableConfiguration {
  connection: object;
  executables: Record<string, string>;
}

type CachedNodeExecutables =
  | { readonly ok: true; readonly executables: Record<string, string> | undefined }
  | { readonly ok: false; readonly error: string };

const FAILED_EXECUTABLE_CONFIG_DIGEST = 'invalid:pool-resolution-failed';

export interface NativeReadResult<T> {
  payload: T;
}

/** Singleton source owner. Client connections own bounded interests, not collectors. */
export class GatewayNativeObservations {
  private readonly clients = new Map<object, NativeConnection>();
  private readonly remote = new Map<string, RemoteSource>();
  private readonly registrationDigests = new WeakMap<object, string>();
  private local?: NativeHostObservation;
  private localReceipt?: NativeSourceReceipt;
  private localSessionRevision = 0;
  private localExecutables?: Record<string, string>;
  private localConfig: SourceConfigState = createSourceConfigState();
  private poolCatalogRevision = 0;
  private executableCacheSnapshot?: MachinePoolSnapshot;
  private readonly executableCache = new Map<string, CachedNodeExecutables>();

  private readonly stopCatalogNotices: () => void;
  private readonly stopVisibleNotices: () => void;
  /** Whether any connection observes the native catalog, whose node model lists then need refreshing. */
  hasCatalogInterest(): boolean {
    return [...this.clients.values()].some((client) => client.catalogInterest !== undefined);
  }

  constructor(
    private readonly invalidate: (key: NativeObservationKey) => void,
    private readonly localClient: NativeSessionClient = nativeSessionManager,
    private readonly readPoolSnapshot?: () => SlotPools,
  ) {
    this.stopCatalogNotices = nativeCatalogChanges.subscribe((change) =>
      this.catalogChanged(change),
    );
    this.stopVisibleNotices = visibleModelPreferenceChanges.subscribe((change) =>
      this.visibleModelsChanged(change),
    );
  }
  /** Advances the owner profile key only for a current reader of that principal generation. */
  visibleModelsChanged(change: NativeCatalogChange): void {
    if (change.scope !== 'owner') return;
    for (const client of this.clients.values())
      if (
        client.visibleReader?.id === change.ownerId &&
        client.visibleReader.generation === change.ownerGeneration
      ) {
        this.invalidate({ family: 'profiles', scope: 'owner', ownerId: change.ownerId });
        return;
      }
  }
  /** Arms one shared preference watcher per connection before its observed visible-model read. */
  observeVisibleModels(connection: object, reader: Principal): void {
    const client = this.clients.get(connection);
    if (!client)
      throw new GatewayMethodError('AUTH_FORBIDDEN', 'Visible model read connection ended');
    const generation = reader.generation ?? 0;
    if (
      !client.visiblePreferences ||
      client.visibleReader?.id !== reader.id ||
      client.visibleReader.generation !== generation
    ) {
      client.visiblePreferences?.dispose();
      client.visiblePreferences = undefined;
      client.visiblePreferences = runWithSessionOriginator(reader, () =>
        observeVisibleModelPreferences(),
      );
      client.visibleReader = { id: reader.id, generation };
    }
    try {
      client.visiblePreferences.sample();
    } catch (error) {
      // The failed sample published its failure notice; the read reports the file error itself.
      if (!(error instanceof NativeCatalogSourceUnavailable)) throw error;
    }
  }
  catalogChanged(change: NativeCatalogChange): void {
    if (change.scope === 'all') {
      this.poolCatalogRevision++;
      if (change.reason === 'pool') {
        this.syncExecutablesOnPoolChange();
      }
    }
    const interests = [];
    for (const client of this.clients.values()) {
      const interest = client.catalogInterest;
      const reader = client.catalogReader;
      if (!interest || !reader) continue;
      const key = interest.key;
      if (
        interest.method !== 'native.session.catalog' ||
        key.family !== 'native-session' ||
        !('scope' in key) ||
        key.scope !== 'owner'
      )
        continue;
      interests.push({
        method: interest.method,
        key: { family: 'native-session' as const, scope: 'owner' as const, ownerId: key.ownerId },
        readerGeneration: reader.generation,
      });
    }
    for (const key of changedNativeCatalogKeys(change, interests)) this.invalidate(key);
  }
  private catalogSample(client: NativeConnection, reader: Principal): NativeCatalogSourceReceipt {
    if (
      !client.catalogPreferences ||
      client.catalogReader?.id !== reader.id ||
      client.catalogReader.generation !== (reader.generation ?? 0)
    ) {
      client.catalogPreferences?.dispose();
      client.catalogInterest = undefined;
      client.catalogPreferences = runWithSessionOriginator(reader, () =>
        observeNativeCatalogPreferences(),
      );
      client.catalogReader = { id: reader.id, generation: reader.generation ?? 0 };
    }
    try {
      return client.catalogPreferences.sample();
    } catch (error) {
      if (error instanceof NativeCatalogSourceUnavailable) throw new NativeSourceUnavailable();
      throw error;
    }
  }

  async startLocal(ownerId: string): Promise<void> {
    if (!ownsLocalNativeProfile(ownerId))
      throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native local source is unavailable');
    this.local?.stop();
    this.localConfig = createSourceConfigState();
    this.localSessionRevision = 0;
    const resolved = this.resolveCachedNodeExecutablesResult('local');
    const desired = this.desiredFromCached(resolved);
    this.applyDesiredSourceConfig(this.localConfig, desired);
    const epoch = this.localConfig.epoch;
    if (desired.kind === 'valid') {
      this.localExecutables = desired.executables ? { ...desired.executables } : undefined;
    } else {
      this.localExecutables = undefined;
      console.warn(
        `[native-observation] local pool executable resolution failed: ${desired.error}`,
      );
    }
    const initialDigest =
      desired.kind === 'valid' ? desired.digest : `${FAILED_EXECUTABLE_CONFIG_DIGEST}:${epoch}`;
    const local = new NativeHostObservation(
      this.localClient,
      ownerId,
      (receipt) => {
        if (this.local !== local) return;
        const prev = this.localReceipt
          ? { receipt: this.localReceipt, sessionRevision: this.localSessionRevision }
          : undefined;
        this.localReceipt = receipt;
        this.localSessionRevision = this.nextSessionRevision(prev, receipt);
        if (
          receipt.ready &&
          this.localConfig.desired?.kind === 'valid' &&
          !this.localConfig.configuring &&
          !this.localConfig.errorIsPoolResolution &&
          (this.localConfig.committedEpoch !== this.localConfig.epoch ||
            this.localConfig.committedDigest !== this.localConfig.desired.digest ||
            Boolean(this.localConfig.error)) &&
          local.hasExecutableConfigSample(this.localConfig.desired.digest)
        ) {
          this.localConfig.committedEpoch = this.localConfig.epoch;
          this.localConfig.committedDigest = this.localConfig.desired.digest;
          this.localConfig.error = undefined;
          this.localConfig.errorIsPoolResolution = false;
          this.localConfig.heldProfileNoticeEpoch = undefined;
        }
        this.publishReceiptFacets(
          receipt.nodeId,
          receipt.ownerId,
          receipt.changed,
          this.localConfig,
        );
      },
      undefined,
      undefined,
      (runner) => {
        if (this.local !== local) {
          throw new NativeSourceUnavailable('source-stopped');
        }
        if (this.localConfig.desired?.kind === 'error' || this.localConfig.errorIsPoolResolution) {
          throw new Error(
            this.localConfig.desired?.kind === 'error'
              ? this.localConfig.desired.error
              : (this.localConfig.error ?? 'Local pool executable resolution failed'),
          );
        }
        return this.localExecutables?.[normalizeRunner(runner)];
      },
      initialDigest,
      desired.kind === 'error',
    );
    this.local = local;
    await local.start();
    if (
      this.local === local &&
      this.localConfig.epoch === epoch &&
      desired.kind === 'valid' &&
      (this.localConfig.committedEpoch !== epoch ||
        this.localConfig.committedDigest !== desired.digest)
    ) {
      this.localConfig.committedEpoch = epoch;
      this.localConfig.committedDigest = desired.digest;
      this.localConfig.error = undefined;
      this.localConfig.errorIsPoolResolution = false;
      if (this.localReceipt) {
        this.invalidateSource('local', this.localReceipt.ownerId, ['profiles']);
      }
    }
  }

  localProfileStatus(ownerId: string, profileId: string): unknown {
    if (!this.local || this.localReceipt?.ownerId !== ownerId || !ownsLocalNativeProfile(ownerId))
      throw new NativeSourceUnavailable();
    return this.local.profileStatus(profileId);
  }

  /** Socket object and issued authority are supplied only by the existing authenticated registry. */
  acceptRemote(connection: object, receipt: NativeSourceReceipt, current: () => boolean): void {
    validateReceipt(receipt);
    const registered = resolveNativeExecutionNode(receipt.ownerId, receipt.nodeId);
    if (
      registered.ws !== connection ||
      !(registered.nativeSessions as { supportsObservations?: boolean }).supportsObservations
    )
      throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native observation socket is not registered');
    if (!current())
      throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native source socket is not current');
    const previous = this.remote.get(receipt.nodeId);
    if (
      previous?.connection === connection &&
      previous.receipt.incarnation === receipt.incarnation &&
      receipt.revision < previous.receipt.revision
    )
      throw new GatewayMethodError('INVALID_PARAMS', 'Native source revision went backwards');
    const isNewConnection = previous?.connection !== connection;
    const supportsConfig = Boolean(registered.nativeSessions.supportsObservationConfiguration);
    const config = isNewConnection ? createSourceConfigState() : previous.config;
    const updated: RemoteSource = {
      connection,
      current,
      receipt: { ...receipt },
      supportsObservationConfiguration: supportsConfig,
      config,
    };
    this.remote.set(receipt.nodeId, updated);
    const registrationDigest = this.registrationDigests.get(connection);
    if (receipt.ready) {
      const desired = this.syncDesiredForSource(receipt.nodeId, config);
      this.registrationDigests.delete(connection);
      // Receipt readiness acknowledges the initial sample on this socket. An edit during
      // registration must still use the ordinary live-configuration path.
      if (
        !config.configuring &&
        desired.kind === 'valid' &&
        desired.digest === registrationDigest
      ) {
        config.committedEpoch = config.epoch;
        config.committedDigest = registrationDigest;
      }
    }
    if (previous && previous.connection !== connection)
      this.invalidateSource(previous.receipt.nodeId, previous.receipt.ownerId);
    this.publishReceiptFacets(
      receipt.nodeId,
      receipt.ownerId,
      receipt.changed,
      updated.config,
      supportsConfig,
    );
    const recoveredReady =
      isNewConnection ||
      !previous?.receipt.ready ||
      previous.receipt.incarnation !== receipt.incarnation;
    if (
      receipt.ready &&
      supportsConfig &&
      updated.config.committedEpoch !== updated.config.epoch &&
      !updated.config.configuring &&
      !updated.config.errorIsPoolResolution &&
      (!updated.config.error || recoveredReady)
    ) {
      this.triggerRemoteExecutableSync(receipt.nodeId, receipt.ownerId);
    }
  }
  registrationExecutables(
    nodeId: string,
    declaration?: NativeExecutionNodeDeclaration,
  ): Record<string, string> | undefined {
    if (
      !declaration?.supportsInitialObservationConfiguration ||
      !declaration.supportsObservationConfiguration ||
      !declaration.supportsObservations
    )
      return undefined;
    const owner = readCredentialStoreSnapshot().principals.find(
      (principal) => principal.id === declaration.ownerPrincipalId,
    );
    if (!owner || owner.subject.type === 'node' || (owner.generation ?? 0) !== 0) return undefined;
    const resolved = this.resolveCachedNodeExecutablesResult(nodeId);
    // Preserve registration and session reads on a broken pool. The profile gate reports the error.
    return resolved.ok ? (resolved.executables ?? {}) : undefined;
  }

  /** Existing node registration owner calls this even for old/unsupported replacement nodes. */
  registrationChanged(
    nodeId: string,
    ownerId?: string,
    previousConnection?: object,
    initial?: RegisteredExecutableConfiguration,
  ): void {
    if (previousConnection) this.disconnectRemote(previousConnection);
    if (initial)
      this.registrationDigests.set(
        initial.connection,
        canonicalTrustedExecutablesDigest(initial.executables),
      );
    if (ownerId) this.invalidateSource(nodeId, ownerId);
  }

  disconnectRemote(connection: object): void {
    this.registrationDigests.delete(connection);
    for (const [nodeId, source] of this.remote)
      if (source.connection === connection) {
        this.remote.delete(nodeId);
        this.invalidateSource(nodeId, source.receipt.ownerId);
      }
  }
  attachClient(connection: object, principal: () => Principal): void {
    this.clients.get(connection)?.catalogPreferences?.dispose();
    this.clients.get(connection)?.visiblePreferences?.dispose();
    this.clients.set(connection, { principal, interests: new Map() });
  }
  detachClient(connection: object): void {
    this.clients.get(connection)?.catalogPreferences?.dispose();
    this.clients.get(connection)?.visiblePreferences?.dispose();
    this.clients.delete(connection);
  }

  /** Reauthorize immediately before publication. A never receives B's key, IDs or revisions. */
  async canReadKey(connection: object, key: NativeObservationKey): Promise<boolean> {
    const client = this.clients.get(connection);
    const interest = client?.interests.get(keyId(key));
    if (!client || !interest) return false;
    try {
      await authorizeNativeObservation(client.principal(), interest);
      return true;
    } catch (error) {
      if (
        error instanceof GatewayMethodError &&
        ['AUTH_FORBIDDEN', 'NOT_FOUND'].includes(error.code)
      ) {
        client.interests.delete(keyId(key));
        return false;
      }
      throw error;
    }
  }

  /** Brackets EACH cursor page. Raw after/limit reach read unchanged; keys are supplied separately.
   * sample must run after initial source fences and before read. No command can enter this helper. */
  async read<T, S>(
    connection: object,
    interests: NativeInterest[],
    read: () => Promise<T>,
    sample: () => S,
  ): Promise<{ payload: T; resourceState: S }> {
    const client = this.clients.get(connection);
    if (!client) throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native read connection ended');
    const reader = client.principal();
    const readerMetadata = JSON.stringify(reader);
    client.standaloneAdmin = isStandaloneAdmin(reader);
    let collectionOwners: Readonly<Record<string, string>> | undefined;
    const sources = new Map<string, NativeSourceReceipt>();
    let localSessionRevisionBefore: number | undefined;
    const admittedProfileEpochs = new Map<string, AdmittedProfileEpoch>();
    let catalogBefore: NativeCatalogSourceReceipt | undefined;
    const poolCatalogBefore = this.poolCatalogRevision;
    const metadata = new Map<NativeInterest, NativeCollectionMetadata>();
    const authorities = new Map<NativeInterest, NativeReadAuthority>();
    let admitted: Set<string> | undefined;
    const skipped = new Set<string>();
    const skippedReceipts = new Map<string, string | undefined>();

    for (const interest of interests) {
      if (!NATIVE_OBSERVED_READS.has(interest.method))
        throw new GatewayMethodError('INVALID_PARAMS', 'Native commands cannot enter the cache');
      const authority = await authorizeNativeObservation(reader, interest);
      authorities.set(interest, authority);
      // An authorized collection must hear recovery even when its initial source
      // is unavailable. Detail aliases still require the route's exact session identity.
      if (!('sessionId' in interest.key) || !interest.key.sessionId)
        this.remember(client, interest);
      if (interest.method === 'native.session.catalog')
        catalogBefore = this.catalogSample(client, reader);
      const collection = 'scope' in interest.key;
      const catalog = interest.method === 'native.session.catalog';
      const partialList = collection && interest.method === 'native.session.list';
      if (catalog || partialList)
        metadata.set(
          interest,
          collectionMetadata(authority.ownerId, authority.nodes, authority.owners),
        );
      // Catalog consumes pool/registration/preference metadata, never transcript journals.
      if (catalog) continue;
      if (partialList) {
        admitted = new Set();
        collectionOwners = authority.owners;
      }
      for (const node of authority.nodes) {
        // An invalid backing owner disables only this admin target; caller authority still fails closed.
        if (
          partialList &&
          authority.owners &&
          !isGenerationZeroPrincipal(
            readCredentialStoreSnapshot().principals,
            sourceOwner(authority, node),
          )
        ) {
          skipped.add(node);
          skippedReceipts.set(
            node,
            JSON.stringify(node === 'local' ? this.localReceipt : this.remote.get(node)?.receipt),
          );
          continue;
        }
        if (partialList && node !== 'local') {
          const registered = getNode(node);
          if (
            !registered ||
            registered.nativeSessions?.ownerPrincipalId !== sourceOwner(authority, node) ||
            !registered.nativeAuthority?.valid() ||
            !(registered.nativeSessions as { supportsObservations?: boolean }).supportsObservations
          ) {
            skipped.add(node);
            skippedReceipts.set(node, JSON.stringify(this.remote.get(node)?.receipt));
            continue;
          }
        }
        // A Retry can re-arm this authorized source owner; it cannot fabricate its receipt.
        try {
          if (interest.method === 'native.profile.status') {
            admittedProfileEpochs.set(
              node,
              this.assertProfileExecutablesReady(node, sourceOwner(authority, node)),
            );
          }
          if (node === 'local' && this.local && !this.local.current().ready)
            await this.local.retry();
          sources.set(node, await this.fence(node, sourceOwner(authority, node)));
          if (node === 'local') localSessionRevisionBefore = this.localSessionRevision;
          if (partialList) admitted!.add(node);
        } catch (error) {
          // Only source/transport unavailability is a partial-inventory outcome.
          // Unexpected authorization and programming errors remain visible.
          if (
            !partialList ||
            !(error instanceof NativeSourceUnavailable || isNodeTransportUnavailableError(error))
          )
            throw error;
          skipped.add(node);
          skippedReceipts.set(
            node,
            JSON.stringify(node === 'local' ? this.localReceipt : this.remote.get(node)?.receipt),
          );
        }
      }
    }
    const aggregateFence = () => {
      if (
        this.clients.get(connection) !== client ||
        JSON.stringify(client.principal()) !== readerMetadata
      )
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native read authority changed');
      for (const [interest, authority] of authorities) {
        authorityGuards.get(authority)?.();
        const beforeMetadata = metadata.get(interest);
        if (
          beforeMetadata &&
          !sameCollectionMetadata(
            beforeMetadata,
            collectionMetadata(authority.ownerId, authority.nodes, authority.owners),
          )
        )
          throw new NativeSourceUnavailable();
        if (interest.method === 'native.session.catalog') continue;
        for (const node of authority.nodes) {
          if (skipped.has(node)) {
            if (
              skippedReceipts.get(node) !==
              JSON.stringify(node === 'local' ? this.localReceipt : this.remote.get(node)?.receipt)
            )
              throw new NativeSourceUnavailable();
            let recovered = false;
            try {
              if (supportsNativeSource(authority, node)) {
                this.cachedFence(node, sourceOwner(authority, node));
                recovered = true;
              }
            } catch (error) {
              if (
                !(
                  error instanceof NativeSourceUnavailable || isNodeTransportUnavailableError(error)
                )
              )
                throw error;
            }
            if (recovered) throw new NativeSourceUnavailable();
          } else {
            if (interest.method === 'native.profile.status') {
              const admittedEpoch = admittedProfileEpochs.get(node);
              if (admittedEpoch !== undefined) {
                this.assertProfileExecutablesCurrent(
                  node,
                  sourceOwner(authority, node),
                  admittedEpoch,
                );
              }
            }
            const before = sources.get(node);
            if (!before) throw new NativeSourceUnavailable('gateway-read-receipt-missing');
            this.assertReceiptFacetCurrent(
              interest,
              node,
              before,
              node === 'local' ? (localSessionRevisionBefore ?? before.revision) : before.revision,
              this.cachedFence(node, sourceOwner(authority, node)),
            );
          }
        }
      }
    };
    aggregateFence();
    const resourceState = sample();
    let payload!: T;
    let failure: unknown;
    let rejected = false;
    try {
      payload = await observedRead.run({ admitted }, read);
    } catch (error) {
      rejected = true;
      failure = error;
    }
    if (this.clients.get(connection) !== client) throw new NativeSourceUnavailable();
    const session = (payload as { session?: NativeSessionInfo } | undefined)?.session;
    const checkedSources = new Set<string>();
    for (const interest of interests) {
      const verified = { ...interest, ...(session ? { session } : {}) };
      const authority = await authorizeNativeObservation(client.principal(), verified);
      authorities.set(interest, authority);
      if (
        client.principal().id !== reader.id ||
        (client.principal().generation ?? 0) !== (reader.generation ?? 0)
      )
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native read authority changed');
      const key = verified.key;
      if (!rejected && 'sessionId' in key && key.sessionId && !verified.session)
        throw new GatewayMethodError(
          'INVALID_PARAMS',
          'Native detail read omitted session identity',
        );
      // Ten opened sessions plus collection/profile interests; replacement removes retired pins.
      if (!rejected) this.remember(client, verified);
      const beforeMetadata = metadata.get(interest);
      if (
        beforeMetadata &&
        !sameCollectionMetadata(
          beforeMetadata,
          collectionMetadata(authority.ownerId, authority.nodes, authority.owners),
        )
      )
        throw new NativeSourceUnavailable();
      if (interest.method === 'native.session.catalog') continue;
      for (const node of authority.nodes) {
        if (skipped.has(node)) {
          if (
            skippedReceipts.get(node) !==
            JSON.stringify(node === 'local' ? this.localReceipt : this.remote.get(node)?.receipt)
          )
            throw new NativeSourceUnavailable();
          // Recovery during a held page changes its availability projection. Refetch it.
          let recovered = false;
          try {
            if (supportsNativeSource(authority, node)) {
              await this.fence(node, sourceOwner(authority, node));
              recovered = true;
            }
          } catch (error) {
            if (
              !(error instanceof NativeSourceUnavailable || isNodeTransportUnavailableError(error))
            )
              throw error;
          }
          if (recovered) throw new NativeSourceUnavailable();
          continue;
        }
        checkedSources.add(node);
        if (interest.method === 'native.profile.status') {
          const admittedEpoch = admittedProfileEpochs.get(node);
          if (admittedEpoch !== undefined) {
            this.assertProfileExecutablesCurrent(node, sourceOwner(authority, node), admittedEpoch);
          }
        }
        const before = sources.get(node);
        if (!before) throw new NativeSourceUnavailable('gateway-read-receipt-missing');
        this.assertReceiptFacetCurrent(
          interest,
          node,
          before,
          node === 'local' ? (localSessionRevisionBefore ?? before.revision) : before.revision,
          await this.fence(node, sourceOwner(authority, node)),
        );
      }
    }
    // No await follows this aggregate check: an earlier source cannot go stale behind a later scan.
    aggregateFence();
    if (!rejected && admitted)
      validatePartialNativeList(payload, admitted, skipped, reader.id, collectionOwners);
    if (catalogBefore) {
      if (poolCatalogBefore !== this.poolCatalogRevision) throw new NativeSourceUnavailable();
      const after = this.catalogSample(client, client.principal());
      if (
        !after.ready ||
        catalogBefore.incarnation !== after.incarnation ||
        catalogBefore.revision !== after.revision
      )
        throw new NativeSourceUnavailable();
    }
    if (checkedSources.size !== sources.size) throw new NativeSourceUnavailable();
    if (rejected) throw failure;
    return { payload, resourceState };
  }

  private remember(client: NativeConnection, interest: NativeInterest): void {
    if (interest.method === 'native.session.catalog') client.catalogInterest = interest;
    client.interests.delete(keyId(interest.key));
    client.interests.set(keyId(interest.key), interest);
    while (client.interests.size > 32)
      client.interests.delete(client.interests.keys().next().value!);
  }

  /** Validates the node's internal envelope while routing through the existing native.session RPC. */
  unwrapRemote<T>(connection: object, nodeId: string, envelope: unknown): T {
    const source = this.remote.get(nodeId);
    if (!source || source.connection !== connection || !source.current())
      throw new NativeSourceUnavailable();
    if (resolveNativeExecutionNode(source.receipt.ownerId, nodeId).ws !== connection)
      throw new NativeSourceUnavailable();
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      !('nativeSource' in envelope) ||
      !('value' in envelope)
    )
      throw new NativeSourceUnavailable();
    const receipt = envelope.nativeSource as NativeSourceReceipt;
    validateReceipt(receipt);
    assertNativeSourceCurrent(receipt, source.receipt, 'remote-envelope');
    return envelope.value as T;
  }
  dispose(): void {
    this.stopCatalogNotices();
    this.stopVisibleNotices();
    for (const client of this.clients.values()) {
      client.catalogPreferences?.dispose();
      client.visiblePreferences?.dispose();
    }
    this.local?.stop();
    this.clients.clear();
    this.remote.clear();
  }

  private machinePoolSnapshot() {
    return this.readPoolSnapshot
      ? indexMachinePoolSnapshot(this.readPoolSnapshot())
      : readMachinePoolSnapshot();
  }

  private resolveCachedNodeExecutablesResult(nodeId: string): CachedNodeExecutables {
    // Production reads share the watcher's current snapshot even before a coalesced
    // publication. Fixture suppliers refresh when explicitly notified of edits.
    const index =
      this.readPoolSnapshot && this.executableCacheSnapshot
        ? this.executableCacheSnapshot
        : this.machinePoolSnapshot();
    if (this.executableCacheSnapshot !== index) {
      this.executableCache.clear();
      this.executableCacheSnapshot = index;
    }
    const cached = this.executableCache.get(nodeId);
    if (cached) return cached;
    let entry: CachedNodeExecutables;
    try {
      entry = { ok: true, executables: resolveTrustedNativeExecutablesFromIndex(index, nodeId) };
    } catch (error) {
      entry = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.executableCache.set(nodeId, entry);
    return entry;
  }

  private desiredFromCached(resolved: CachedNodeExecutables): SourceDesiredConfig {
    return resolved.ok
      ? {
          kind: 'valid',
          digest: canonicalTrustedExecutablesDigest(resolved.executables),
          executables: resolved.executables,
        }
      : { kind: 'error', error: resolved.error };
  }

  /**
   * Apply a newly resolved desired configuration to one source's state machine.
   * Bumps `state.epoch` on EVERY effective transition (including `valid B -> error -> valid B`)
   * while leaving unaffected sources at their existing epoch.
   */
  private applyDesiredSourceConfig(state: SourceConfigState, next: SourceDesiredConfig): boolean {
    const sameDesired =
      (next.kind === 'valid' &&
        state.desired?.kind === 'valid' &&
        state.desired.digest === next.digest) ||
      (next.kind === 'error' &&
        state.desired?.kind === 'error' &&
        state.desired.error === next.error);
    if (sameDesired) return false;
    state.epoch++;
    state.desired = next;
    state.configuring = undefined;
    state.heldProfileNoticeEpoch = undefined;
    if (next.kind === 'error') {
      state.committedEpoch = -1;
      state.committedDigest = undefined;
      state.error = next.error;
      state.errorIsPoolResolution = true;
    } else {
      state.error = undefined;
      state.errorIsPoolResolution = false;
    }
    return true;
  }

  private syncDesiredForSource(nodeId: string, state: SourceConfigState): SourceDesiredConfig {
    const next = this.desiredFromCached(this.resolveCachedNodeExecutablesResult(nodeId));
    this.applyDesiredSourceConfig(state, next);
    return next;
  }

  private canPublishProfiles(state: SourceConfigState, requiresConfig = true): boolean {
    if (state.desired?.kind === 'error' || state.error || state.configuring) return false;
    if (!requiresConfig) return true;
    return state.desired?.kind === 'valid' && state.committedEpoch === state.epoch;
  }

  /**
   * Publish receipt invalidations per facet:
   * - `native-session` always publishes immediately so session streams stay live during profile config.
   * - `profiles` publishes only when the source's current configuration epoch is committed and
   *   unblocked; notices suppressed while `configuring` is active for `state.epoch` record
   *   `heldProfileNoticeEpoch` so a same-epoch failure still notifies subscribers once.
   */
  private publishReceiptFacets(
    nodeId: string,
    ownerId: string,
    changed: readonly string[] | undefined,
    state: SourceConfigState,
    requiresConfig = true,
  ): void {
    const sessionChanged = !changed || changed.includes('native-session');
    const profileChanged = !changed || changed.includes('profiles');
    const allowProfiles = profileChanged && this.canPublishProfiles(state, requiresConfig);
    if (sessionChanged && allowProfiles) {
      this.invalidateSource(nodeId, ownerId, ['native-session', 'profiles']);
      return;
    }
    if (sessionChanged) {
      this.invalidateSource(nodeId, ownerId, ['native-session']);
    }
    if (allowProfiles) {
      this.invalidateSource(nodeId, ownerId, ['profiles']);
    } else if (profileChanged && state.configuring && state.configuring.epoch === state.epoch) {
      state.heldProfileNoticeEpoch = state.epoch;
    }
  }

  private nextSessionRevision(
    previous: { receipt: NativeSourceReceipt; sessionRevision: number } | undefined,
    next: NativeSourceReceipt,
  ): number {
    if (
      !previous ||
      previous.receipt.incarnation !== next.incarnation ||
      !next.ready ||
      !next.changed ||
      next.changed.includes('native-session')
    ) {
      return next.revision;
    }
    return previous.sessionRevision;
  }

  /**
   * Fence a marked read against receipt changes for its own facet:
   * - Local `native-session` reads survive profile-only advances (`changed: ['profiles']`) on the
   *   same ready incarnation while still rejecting on any real session change, unavailability, or
   *   incarnation replacement. Remote reads retain the existing full-receipt envelope check
   *   without widening the remote wire contract.
   * - `profiles` reads check the full source receipt.
   */
  private assertReceiptFacetCurrent(
    interest: NativeInterest,
    nodeId: string,
    before: NativeSourceReceipt,
    beforeSessionRevision: number,
    after: NativeSourceReceipt,
  ): void {
    if (nodeId === 'local' && interest.key.family === 'native-session') {
      if (!before.ready || !after.ready || before.incarnation !== after.incarnation) {
        assertNativeSourceCurrent(before, after, 'gateway-read');
        return;
      }
      if (this.localSessionRevision !== beforeSessionRevision) {
        assertNativeSourceCurrent(
          before,
          { ...after, revision: Math.max(after.revision, before.revision + 1) },
          'gateway-read',
        );
      }
      return;
    }
    assertNativeSourceCurrent(before, after, 'gateway-read');
  }

  /**
   * Non-blocking picker gate: never await a slow account sample on the read path.
   * Cached pool-resolution failures fail closed with `NATIVE_PROFILES_UNAVAILABLE` without
   * rescanning the pool directory until the next real pool edit.
   */
  private assertProfileExecutablesReady(nodeId: string, ownerId: string): AdmittedProfileEpoch {
    if (nodeId === 'local') {
      const desired = this.syncDesiredForSource('local', this.localConfig);
      if (desired.kind === 'error') {
        throw new GatewayMethodError(
          'NATIVE_PROFILES_UNAVAILABLE',
          `Native account profiles failed to resolve runner configuration: ${desired.error}`,
        );
      }
      if (!this.local) return { epoch: this.localConfig.epoch, digest: desired.digest };
      if (
        this.localConfig.error ||
        this.localConfig.committedEpoch !== this.localConfig.epoch ||
        this.localConfig.committedDigest !== desired.digest ||
        this.localConfig.configuring
      ) {
        const priorError = this.localConfig.error;
        this.triggerLocalExecutableSync(desired.executables, true);
        throw new GatewayMethodError(
          'NATIVE_PROFILES_UNAVAILABLE',
          priorError
            ? `Native account profiles failed to sync runner configuration: ${priorError}`
            : 'Native account profiles are refreshing for updated runner configuration. Retry shortly.',
        );
      }
      return { epoch: this.localConfig.epoch, digest: desired.digest };
    }
    const source = this.remote.get(nodeId);
    if (!source || !source.current()) {
      const resolved = this.resolveCachedNodeExecutablesResult(nodeId);
      if (!resolved.ok) {
        throw new GatewayMethodError(
          'NATIVE_PROFILES_UNAVAILABLE',
          `Native account profiles failed to resolve runner configuration: ${resolved.error}`,
        );
      }
      return { epoch: 0, digest: canonicalTrustedExecutablesDigest(resolved.executables) };
    }
    const desired = this.syncDesiredForSource(nodeId, source.config);
    if (desired.kind === 'error') {
      throw new GatewayMethodError(
        'NATIVE_PROFILES_UNAVAILABLE',
        `Native account profiles failed to resolve runner configuration: ${desired.error}`,
      );
    }
    const node = resolveNativeExecutionNode(ownerId, nodeId);
    if (node.ws !== source.connection)
      return { epoch: source.config.epoch, digest: desired.digest };
    if (!node.nativeSessions.supportsObservationConfiguration) {
      if (desired.digest !== EMPTY_TRUSTED_EXECUTABLES_DIGEST) {
        throw new GatewayMethodError(
          'NATIVE_SOURCE_UNAVAILABLE',
          'Execution node upgrade required for configured runner executables',
        );
      }
      source.config.committedEpoch = source.config.epoch;
      source.config.committedDigest = desired.digest;
      return { epoch: source.config.epoch, digest: desired.digest };
    }
    if (
      source.config.error ||
      source.config.committedEpoch !== source.config.epoch ||
      source.config.committedDigest !== desired.digest ||
      source.config.configuring
    ) {
      const priorError = source.config.error;
      this.triggerRemoteExecutableSync(nodeId, ownerId, desired.executables, true);
      throw new GatewayMethodError(
        'NATIVE_PROFILES_UNAVAILABLE',
        priorError
          ? `Native account profiles failed to sync runner configuration: ${priorError}`
          : 'Native account profiles are refreshing for updated runner configuration. Retry shortly.',
      );
    }
    return { epoch: source.config.epoch, digest: desired.digest };
  }

  /**
   * Synchronous publication fence for admitted `native.profile.status` reads.
   * Rejects any read straddling an effective executable configuration transition (including
   * `valid B -> ambiguous -> valid B` with an unchanged receipt revision) on either local or
   * remote nodes, without disturbing unaffected nodes or session reads.
   */
  private assertProfileExecutablesCurrent(
    nodeId: string,
    ownerId: string,
    admitted: AdmittedProfileEpoch,
  ): void {
    if (nodeId === 'local') {
      const desired = this.syncDesiredForSource('local', this.localConfig);
      if (desired.kind === 'error') {
        throw new GatewayMethodError(
          'NATIVE_PROFILES_UNAVAILABLE',
          `Native account profiles failed to resolve runner configuration: ${desired.error}`,
        );
      }
      if (
        !this.local ||
        this.localConfig.error ||
        this.localConfig.configuring ||
        this.localConfig.committedEpoch !== this.localConfig.epoch ||
        this.localConfig.committedDigest !== desired.digest
      ) {
        const priorError = this.localConfig.error;
        throw new GatewayMethodError(
          'NATIVE_PROFILES_UNAVAILABLE',
          priorError
            ? `Native account profiles failed to sync runner configuration: ${priorError}`
            : 'Native account profiles are refreshing for updated runner configuration. Retry shortly.',
        );
      }
      if (this.localConfig.epoch !== admitted.epoch || desired.digest !== admitted.digest) {
        throw new NativeSourceUnavailable('executable-config-changed');
      }
      return;
    }
    const source = this.remote.get(nodeId);
    if (!source || !source.current()) return;
    const desired = this.syncDesiredForSource(nodeId, source.config);
    if (desired.kind === 'error') {
      throw new GatewayMethodError(
        'NATIVE_PROFILES_UNAVAILABLE',
        `Native account profiles failed to resolve runner configuration: ${desired.error}`,
      );
    }
    const node = resolveNativeExecutionNode(ownerId, nodeId);
    if (node.ws !== source.connection) return;
    if (!node.nativeSessions.supportsObservationConfiguration) {
      if (
        desired.digest !== admitted.digest ||
        desired.digest !== EMPTY_TRUSTED_EXECUTABLES_DIGEST
      ) {
        throw new GatewayMethodError(
          'NATIVE_SOURCE_UNAVAILABLE',
          'Execution node upgrade required for configured runner executables',
        );
      }
      if (source.config.epoch !== admitted.epoch) {
        throw new NativeSourceUnavailable('executable-config-changed');
      }
      return;
    }
    if (
      source.config.error ||
      source.config.configuring ||
      source.config.committedEpoch !== source.config.epoch ||
      source.config.committedDigest !== desired.digest
    ) {
      const priorError = source.config.error;
      throw new GatewayMethodError(
        'NATIVE_PROFILES_UNAVAILABLE',
        priorError
          ? `Native account profiles failed to sync runner configuration: ${priorError}`
          : 'Native account profiles are refreshing for updated runner configuration. Retry shortly.',
      );
    }
    if (source.config.epoch !== admitted.epoch || desired.digest !== admitted.digest) {
      throw new NativeSourceUnavailable('executable-config-changed');
    }
  }

  private triggerLocalExecutableSync(
    preResolved?: Record<string, string> | undefined,
    hasPreResolved = false,
  ): void {
    const local = this.local;
    const epoch = this.localConfig.epoch;
    void this.syncLocalExecutables(preResolved, hasPreResolved).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (this.local === local && this.localConfig.epoch === epoch) {
        this.localConfig.error = message;
        this.localConfig.errorIsPoolResolution = false;
        if (this.localConfig.heldProfileNoticeEpoch === epoch) {
          this.localConfig.heldProfileNoticeEpoch = undefined;
          if (this.localReceipt) {
            this.invalidateSource('local', this.localReceipt.ownerId, ['profiles']);
          }
        }
      }
      console.warn(`[native-observation] background local executable sync failed: ${message}`);
    });
  }

  private async syncLocalExecutables(
    preResolved?: Record<string, string> | undefined,
    hasPreResolved = false,
  ): Promise<void> {
    if (!this.local) return;
    const local = this.local;
    let executables = preResolved;
    if (!hasPreResolved) {
      const desired = this.syncDesiredForSource('local', this.localConfig);
      if (desired.kind === 'error') {
        this.localExecutables = undefined;
        local.invalidateExecutableConfig(
          `${FAILED_EXECUTABLE_CONFIG_DIGEST}:${this.localConfig.epoch}`,
        );
        throw new Error(desired.error);
      }
      executables = desired.executables;
    }
    const epoch = this.localConfig.epoch;
    const digest = canonicalTrustedExecutablesDigest(executables);
    if (
      !this.localConfig.error &&
      this.localConfig.committedEpoch === epoch &&
      this.localConfig.committedDigest === digest &&
      !this.localConfig.configuring
    )
      return;
    if (
      this.localConfig.configuring?.epoch === epoch &&
      this.localConfig.configuring.digest === digest
    )
      return this.localConfig.configuring.promise;
    this.localExecutables = executables ? { ...executables } : undefined;
    this.localConfig.error = undefined;
    this.localConfig.errorIsPoolResolution = false;
    this.localConfig.heldProfileNoticeEpoch = undefined;
    let run!: Promise<void>;
    run = (async () => {
      if (!local.current().ready) {
        await local.setExecutableConfig(digest);
        if (this.local !== local || this.localConfig.epoch !== epoch) return;
        await local.retry();
      } else {
        await local.setExecutableConfig(digest);
      }
      if (this.local === local && this.localConfig.epoch === epoch) {
        this.localConfig.committedEpoch = epoch;
        this.localConfig.committedDigest = digest;
        this.localConfig.error = undefined;
        this.localConfig.errorIsPoolResolution = false;
        this.localConfig.heldProfileNoticeEpoch = undefined;
        if (this.localConfig.configuring?.promise === run) this.localConfig.configuring = undefined;
        if (this.localReceipt) {
          this.invalidateSource('local', this.localReceipt.ownerId, ['profiles']);
        }
      }
    })().finally(() => {
      if (this.localConfig.configuring?.promise === run) this.localConfig.configuring = undefined;
    });
    this.localConfig.configuring = { epoch, digest, promise: run };
    await run;
  }

  /**
   * Read the pool directory once on an actual pool edit, index it once by machine, resolve
   * trusted executable maps for all connected observation targets via `resolveMachinePoolEntry`,
   * cache both successes and ambiguity errors until the next pool edit, advance per-source
   * configuration epochs only for sources whose desired state effectively changed, and
   * synchronize only those sources.
   */
  private syncExecutablesOnPoolChange(): void {
    const hasLocal = Boolean(this.local);
    const connectedRemotes: Array<[string, RemoteSource]> = [];
    for (const [nodeId, source] of this.remote) {
      if (source.current()) connectedRemotes.push([nodeId, source]);
    }
    this.executableCache.clear();
    this.executableCacheSnapshot = undefined;
    if (!hasLocal && connectedRemotes.length === 0) return;

    const index = this.machinePoolSnapshot();
    this.executableCacheSnapshot = index;

    if (hasLocal) {
      let nextDesired: SourceDesiredConfig;
      try {
        const localMap = resolveTrustedNativeExecutablesFromIndex(index, 'local');
        this.executableCache.set('local', { ok: true, executables: localMap });
        nextDesired = {
          kind: 'valid',
          digest: canonicalTrustedExecutablesDigest(localMap),
          executables: localMap,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.executableCache.set('local', { ok: false, error: message });
        nextDesired = { kind: 'error', error: message };
        console.warn(`[native-observation] local pool executable resolution failed: ${message}`);
      }
      const changed = this.applyDesiredSourceConfig(this.localConfig, nextDesired);
      if (nextDesired.kind === 'error') {
        this.localExecutables = undefined;
        this.local?.invalidateExecutableConfig(
          `${FAILED_EXECUTABLE_CONFIG_DIGEST}:${this.localConfig.epoch}`,
        );
        if (changed && this.localReceipt) {
          this.invalidateSource('local', this.localReceipt.ownerId, ['profiles']);
        }
      } else if (
        changed ||
        this.localConfig.committedEpoch !== this.localConfig.epoch ||
        this.localConfig.error
      ) {
        this.triggerLocalExecutableSync(nextDesired.executables, true);
      }
    }
    for (const [nodeId, source] of connectedRemotes) {
      let nextDesired: SourceDesiredConfig;
      try {
        const nodeMap = resolveTrustedNativeExecutablesFromIndex(index, nodeId);
        this.executableCache.set(nodeId, { ok: true, executables: nodeMap });
        nextDesired = {
          kind: 'valid',
          digest: canonicalTrustedExecutablesDigest(nodeMap),
          executables: nodeMap,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.executableCache.set(nodeId, { ok: false, error: message });
        nextDesired = { kind: 'error', error: message };
        console.warn(
          `[native-observation] remote pool executable resolution failed for ${nodeId}: ${message}`,
        );
      }
      const changed = this.applyDesiredSourceConfig(source.config, nextDesired);
      if (nextDesired.kind === 'error') {
        if (changed) {
          this.invalidateSource(nodeId, source.receipt.ownerId, ['profiles']);
        }
      } else if (
        changed ||
        source.config.committedEpoch !== source.config.epoch ||
        source.config.error
      ) {
        this.triggerRemoteExecutableSync(
          nodeId,
          source.receipt.ownerId,
          nextDesired.executables,
          true,
        );
      }
    }
  }

  private triggerRemoteExecutableSync(
    nodeId: string,
    ownerId: string,
    preResolved?: Record<string, string> | undefined,
    hasPreResolved = false,
  ): void {
    const initialSource = this.remote.get(nodeId);
    if (!initialSource) return;
    if (!hasPreResolved) {
      const desired = this.syncDesiredForSource(nodeId, initialSource.config);
      if (desired.kind === 'error') {
        this.invalidateSource(nodeId, ownerId, ['profiles']);
        console.warn(
          `[native-observation] remote pool executable resolution failed for ${nodeId}: ${desired.error}`,
        );
        return;
      }
      preResolved = desired.executables;
      hasPreResolved = true;
    }
    const epoch = initialSource.config.epoch;
    const connection = initialSource.connection;
    void this.syncRemoteExecutables(nodeId, ownerId, preResolved, hasPreResolved).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const source = this.remote.get(nodeId);
        if (source && source.connection === connection && source.config.epoch === epoch) {
          source.config.error = message;
          source.config.errorIsPoolResolution = false;
          if (source.config.heldProfileNoticeEpoch === epoch) {
            source.config.heldProfileNoticeEpoch = undefined;
            this.invalidateSource(nodeId, ownerId, ['profiles']);
          }
        }
        console.warn(
          `[native-observation] background remote executable sync failed for ${nodeId}: ${message}`,
        );
      },
    );
  }

  private async syncRemoteExecutables(
    nodeId: string,
    ownerId: string,
    preResolved?: Record<string, string> | undefined,
    hasPreResolved = false,
  ): Promise<void> {
    const source = this.remote.get(nodeId);
    if (!source || !source.current()) return;
    let executables = preResolved;
    if (!hasPreResolved) {
      const desired = this.syncDesiredForSource(nodeId, source.config);
      if (desired.kind === 'error') {
        throw new Error(desired.error);
      }
      executables = desired.executables;
    }
    const epoch = source.config.epoch;
    const digest = canonicalTrustedExecutablesDigest(executables);
    const node = resolveNativeExecutionNode(ownerId, nodeId);
    if (node.ws !== source.connection) return;
    if (!node.nativeSessions.supportsObservationConfiguration) {
      if (digest !== EMPTY_TRUSTED_EXECUTABLES_DIGEST) {
        throw new GatewayMethodError(
          'NATIVE_SOURCE_UNAVAILABLE',
          'Execution node upgrade required for configured runner executables',
        );
      }
      source.config.committedEpoch = epoch;
      source.config.committedDigest = digest;
      source.config.error = undefined;
      source.config.errorIsPoolResolution = false;
      return;
    }
    if (
      !source.config.error &&
      source.config.committedEpoch === epoch &&
      source.config.committedDigest === digest &&
      !source.config.configuring
    )
      return;
    if (source.config.configuring?.epoch === epoch && source.config.configuring.digest === digest)
      return source.config.configuring.promise;
    source.config.error = undefined;
    source.config.errorIsPoolResolution = false;
    source.config.heldProfileNoticeEpoch = undefined;
    let run!: Promise<void>;
    run = (async () => {
      const receipt = await sendNodeRequest(
        node,
        'native.observation.configure',
        {
          owner: ownerId,
          executables: executables ?? {},
        },
        { timeout: 20_000, requireSameConnection: true },
      );
      const currentSource = this.remote.get(nodeId);
      if (!currentSource || currentSource.connection !== node.ws || !currentSource.current())
        return;
      const parsed = receipt as NativeSourceReceipt;
      validateReceipt(parsed);
      this.syncDesiredForSource(nodeId, currentSource.config);
      if (currentSource.config.epoch !== epoch) {
        // Keep the receipt current for unaffected session reads without publishing a stale
        // `profiles` invalidation or clearing a newer configuration state.
        if (
          parsed.incarnation !== currentSource.receipt.incarnation ||
          parsed.revision >= currentSource.receipt.revision
        ) {
          currentSource.receipt = { ...parsed };
          if (!parsed.changed || parsed.changed.includes('native-session')) {
            this.invalidateSource(nodeId, ownerId, ['native-session']);
          }
        }
        return;
      }
      if (
        parsed.incarnation !== currentSource.receipt.incarnation ||
        parsed.revision >= currentSource.receipt.revision
      ) {
        this.acceptRemote(node.ws, parsed, currentSource.current);
      }
      const updated = this.remote.get(nodeId);
      if (updated && updated.connection === node.ws && updated.config.epoch === epoch) {
        updated.config.committedEpoch = epoch;
        updated.config.committedDigest = digest;
        updated.config.error = undefined;
        updated.config.errorIsPoolResolution = false;
        updated.config.heldProfileNoticeEpoch = undefined;
        if (updated.config.configuring?.promise === run) updated.config.configuring = undefined;
        if (source.config.configuring?.promise === run) source.config.configuring = undefined;
        this.invalidateSource(nodeId, ownerId, ['profiles']);
      }
    })().finally(() => {
      const latest = this.remote.get(nodeId);
      if (latest?.config.configuring?.promise === run) latest.config.configuring = undefined;
      if (source.config.configuring?.promise === run) source.config.configuring = undefined;
    });
    source.config.configuring = { epoch, digest, promise: run };
    await run;
  }

  private async fence(nodeId: string, ownerId: string): Promise<NativeSourceReceipt> {
    if (nodeId === 'local') {
      if (!this.local || this.localReceipt?.ownerId !== ownerId)
        throw new NativeSourceUnavailable();
      return this.local.fence();
    }
    return this.cachedFence(nodeId, ownerId);
  }
  private cachedFence(nodeId: string, ownerId: string): NativeSourceReceipt {
    if (nodeId === 'local') {
      if (!this.local || this.localReceipt?.ownerId !== ownerId || !ownsLocalNativeProfile(ownerId))
        throw new NativeSourceUnavailable();
      const receipt = this.local.current();
      if (!receipt.ready) throw new NativeSourceUnavailable();
      return receipt;
    }
    const source = this.remote.get(nodeId);
    const node = resolveNativeExecutionNode(ownerId, nodeId);
    if (
      !source ||
      source.connection !== node.ws ||
      !source.current() ||
      !source.receipt.ready ||
      source.receipt.ownerId !== ownerId
    )
      throw new NativeSourceUnavailable();
    return { ...source.receipt };
  }
  private invalidateSource(
    nodeId: string,
    ownerId: string,
    families: readonly string[] = ['native-session', 'profiles'],
  ): void {
    if (families.includes('native-session')) publishNativeSessionChange(nodeId, ownerId);
    // Keys remain private even here. The server must call canReadKey again before sending.
    const keys = new Map<string, NativeObservationKey>();
    for (const client of this.clients.values())
      for (const interest of client.interests.values()) {
        const key = interest.key;
        if (!families.includes(key.family)) continue;
        if (
          ('scope' in key && (key.ownerId === ownerId || client.standaloneAdmin)) ||
          ('nodeId' in key && key.nodeId === nodeId)
        )
          keys.set(keyId(key), key);
      }
    for (const key of keys.values()) this.invalidate(key);
  }
}
/** Internal route provenance check, not a new wire shape. Every skipped assigned host is explicit. */
export function validatePartialNativeList(
  payload: unknown,
  admitted: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  ownerId: string,
  owners?: Readonly<Record<string, string>>,
): void {
  const result = payload as
    | { sessions?: NativeSessionInfo[]; unavailableExecutionNodes?: { executionNodeId: string }[] }
    | undefined;
  if (
    !result ||
    !Array.isArray(result.sessions) ||
    !Array.isArray(result.unavailableExecutionNodes)
  )
    throw new NativeSourceUnavailable();
  const unavailable = new Set(result.unavailableExecutionNodes.map((n) => n.executionNodeId));
  if (
    result.sessions.some(
      (s) =>
        s.ownerPrincipalId !== (owners?.[s.executionNodeId] ?? ownerId) ||
        !admitted.has(s.executionNodeId) ||
        unavailable.has(s.executionNodeId),
    ) ||
    [...skipped].some((id) => !unavailable.has(id)) ||
    [...unavailable].some((id) => !skipped.has(id) && !admitted.has(id))
  )
    throw new NativeSourceUnavailable();
}
export const NATIVE_OBSERVED_READS = new Set([
  'native.session.read',
  'native.session.list',
  'native.session.catalog',
  'native.profile.list',
  'native.profile.status',
]);
function keyId(key: NativeObservationKey): string {
  return JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));
}
function validateReceipt(value: NativeSourceReceipt): void {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.nodeId !== 'string' ||
    !value.nodeId ||
    typeof value.ownerId !== 'string' ||
    !value.ownerId ||
    typeof value.incarnation !== 'string' ||
    !value.incarnation ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.ready !== 'boolean' ||
    (!value.ready && value.error !== 'SOURCE_UNAVAILABLE')
  )
    throw new GatewayMethodError('INVALID_PARAMS', 'Invalid native source receipt');
}

export const nativeObservations = new GatewayNativeObservations((key) =>
  resourceRevisions.advance(key as ResourceKey),
);

/** Dependency derivation for marked wire pages. This deliberately does not normalize a durable
 * query: cursor and limit remain on params for the real route, never on a cache identity. */
export function nativeReadInterests(
  method: string,
  value: unknown,
  readerId: string,
): NativeInterest[] | undefined {
  if (!NATIVE_OBSERVED_READS.has(method)) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Native read parameters required');
  const params = value as Record<string, unknown>;
  if ('ownerId' in params || 'ownerGeneration' in params)
    throw new GatewayMethodError('INVALID_PARAMS', 'Native reader comes from authentication');
  const family = method.startsWith('native.profile.') ? 'profiles' : 'native-session';
  let key: NativeObservationKey;
  if (params.executionNodeId === undefined && method !== 'native.session.read') {
    key = { family, scope: 'owner', ownerId: readerId };
  } else {
    const nodeId = params.executionNodeId ?? 'local';
    if (typeof nodeId !== 'string' || !nodeId)
      throw new GatewayMethodError('INVALID_PARAMS', 'Native execution node required');
    const worker = params.worker as { runId?: unknown } | undefined;
    if (family === 'native-session') {
      if (params.sessionId !== undefined && typeof params.sessionId !== 'string')
        throw new GatewayMethodError('INVALID_PARAMS', 'Native session ID required');
      if (worker && typeof worker.runId !== 'string')
        throw new GatewayMethodError('INVALID_PARAMS', 'Pinned worker run required');
      key = {
        family,
        nodeId,
        ownerId: readerId,
        ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
        ...(worker ? { workerId: worker.runId as string } : {}),
      };
    } else key = { family, nodeId, ownerId: readerId };
  }
  return [{ key, method, params }];
}
