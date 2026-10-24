import { AsyncLocalStorage } from 'node:async_hooks';

import {
  NativeHostObservation,
  type NativeSourceReceipt,
  NativeSourceUnavailable,
  sameNativeSource,
} from '@farmslot/agent-runtime/native/observation';
import type { NativeSessionInfo, Principal } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';
import { getNode } from '../fleet/machine-registry.js';
import { isNodeTransportUnavailableError } from '../fleet/node-rpc.js';
import { nativeSessionManager } from '../runners/native/manager.js';
import { resolveNativeExecutionNode } from '../runners/native/node.js';
import { authorizeNativeWorkerHistory } from '../runners/native/worker-history.js';
import {
  type NativeCatalogPreferenceLease,
  observeNativeCatalogPreferences,
} from '../runners/visible-models.js';
import { loadCredentialStore } from '../security/credential-store.js';
import { nativeOwnerAssignedMachines } from '../security/native-node.js';
import {
  hasNativeWorkspaceAccess,
  nativeOwnerCanUseWorkers,
  ownsLocalNativeProfile,
  requireNativeSessionOwner,
} from '../security/native-owner.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import {
  changedNativeCatalogKeys,
  type NativeCatalogChange,
  nativeCatalogChanges,
  type NativeCatalogSourceReceipt,
  NativeCatalogSourceUnavailable,
} from './native-catalog-changes.js';
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
function collectionMetadata(ownerId: string, nodes: readonly string[]): NativeCollectionMetadata {
  const store = loadCredentialStore();
  const issued = store.principals.filter(
    (p) => p.subject.type === 'node' && p.subject.nativeOwnerPrincipalId === ownerId,
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
              local: id === 'local' ? ownsLocalNativeProfile(ownerId) : undefined,
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
      if (!hasNativeWorkspaceAccess(reader, loadCredentialStore().principals))
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native owner view is unavailable');
      const ownerId = requireNativeSessionOwner();
      const nodes = [...nativeOwnerAssignedMachines(loadCredentialStore().principals, ownerId)];
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
      const { binding } = await authorizeNativeWorkerHistory(interest.method, interest.params);
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
      return { ownerId: binding.ownerPrincipalId, nodes: [binding.executionNodeId] };
    }
    const ownerId = requireNativeSessionOwner();
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
    return { ownerId, nodes: [key.nodeId] };
  });
}

interface NativeConnection {
  /** Must re-resolve the CURRENT authenticated session, including revocation and generation. */
  principal: () => Principal;
  interests: Map<string, NativeInterest>;
  catalogPreferences?: NativeCatalogPreferenceLease;
  catalogInterest?: NativeInterest;
  catalogReader?: { id: string; generation: number };
}
interface RemoteSource {
  connection: object;
  current: () => boolean;
  receipt: NativeSourceReceipt;
}
export interface NativeReadResult<T> {
  payload: T;
}

/** Singleton source owner. Client connections own bounded interests, not collectors. */
export class GatewayNativeObservations {
  private readonly clients = new Map<object, NativeConnection>();
  private readonly remote = new Map<string, RemoteSource>();
  private local?: NativeHostObservation;
  private localReceipt?: NativeSourceReceipt;
  private poolCatalogRevision = 0;

  private readonly stopCatalogNotices: () => void;
  constructor(private readonly invalidate: (key: NativeObservationKey) => void) {
    this.stopCatalogNotices = nativeCatalogChanges.subscribe((change) =>
      this.catalogChanged(change),
    );
  }
  catalogChanged(change: NativeCatalogChange): void {
    if (change.scope === 'all') this.poolCatalogRevision++;
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
    this.local = new NativeHostObservation(nativeSessionManager, ownerId, (receipt) => {
      this.localReceipt = receipt;
      this.invalidateSource(receipt.nodeId, receipt.ownerId, receipt.changed);
    });
    await this.local.start();
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
    this.remote.set(receipt.nodeId, { connection, current, receipt: { ...receipt } });
    if (previous && previous.connection !== connection)
      this.invalidateSource(previous.receipt.nodeId, previous.receipt.ownerId);
    this.invalidateSource(receipt.nodeId, receipt.ownerId, receipt.changed);
  }
  /** Existing node registration owner calls this even for old/unsupported replacement nodes. */
  registrationChanged(nodeId: string, ownerId?: string, previousConnection?: object): void {
    if (previousConnection) this.disconnectRemote(previousConnection);
    if (ownerId) this.invalidateSource(nodeId, ownerId);
  }

  disconnectRemote(connection: object): void {
    for (const [nodeId, source] of this.remote)
      if (source.connection === connection) {
        this.remote.delete(nodeId);
        this.invalidateSource(nodeId, source.receipt.ownerId);
      }
  }
  attachClient(connection: object, principal: () => Principal): void {
    this.clients.get(connection)?.catalogPreferences?.dispose();
    this.clients.set(connection, { principal, interests: new Map() });
  }
  detachClient(connection: object): void {
    this.clients.get(connection)?.catalogPreferences?.dispose();
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
    const sources = new Map<string, NativeSourceReceipt>();
    let catalogBefore: NativeCatalogSourceReceipt | undefined;
    const poolCatalogBefore = this.poolCatalogRevision;
    const metadata = new Map<NativeInterest, NativeCollectionMetadata>();
    let admitted: Set<string> | undefined;
    const skipped = new Set<string>();
    const skippedReceipts = new Map<string, string | undefined>();

    for (const interest of interests) {
      if (!NATIVE_OBSERVED_READS.has(interest.method))
        throw new GatewayMethodError('INVALID_PARAMS', 'Native commands cannot enter the cache');
      const authority = await authorizeNativeObservation(reader, interest);
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
        metadata.set(interest, collectionMetadata(authority.ownerId, authority.nodes));
      // Catalog consumes pool/registration/preference metadata, never transcript journals.
      if (catalog) continue;
      if (partialList) admitted = new Set();
      for (const node of authority.nodes) {
        if (partialList && node !== 'local') {
          const registered = getNode(node);
          if (
            !registered ||
            registered.nativeSessions?.ownerPrincipalId !== authority.ownerId ||
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
          if (node === 'local' && this.local && !this.local.current().ready)
            await this.local.retry();
          sources.set(node, this.fence(node, authority.ownerId));
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
          collectionMetadata(authority.ownerId, authority.nodes),
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
          const registered = node === 'local' ? undefined : getNode(node);
          const supportsSource =
            node === 'local' ||
            (registered?.nativeSessions?.ownerPrincipalId === authority.ownerId &&
              (registered.nativeSessions as { supportsObservations?: boolean })
                .supportsObservations === true);
          let recovered = false;
          try {
            if (supportsSource) {
              this.fence(node, authority.ownerId);
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
        const before = sources.get(node);
        if (!before || !sameNativeSource(before, this.fence(node, authority.ownerId)))
          throw new NativeSourceUnavailable();
      }
    }
    if (!rejected && admitted) validatePartialNativeList(payload, admitted, skipped, reader.id);
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
    if (!sameNativeSource(source.receipt, receipt)) throw new NativeSourceUnavailable();
    return envelope.value as T;
  }
  dispose(): void {
    this.stopCatalogNotices();
    for (const client of this.clients.values()) client.catalogPreferences?.dispose();
    this.local?.stop();
    this.clients.clear();
    this.remote.clear();
  }

  private fence(nodeId: string, ownerId: string): NativeSourceReceipt {
    if (nodeId === 'local') {
      if (!this.local || this.localReceipt?.ownerId !== ownerId)
        throw new NativeSourceUnavailable();
      return this.local.fence();
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
    // Keys remain private even here. The server must call canReadKey again before sending.
    const keys = new Map<string, NativeObservationKey>();
    for (const client of this.clients.values())
      for (const interest of client.interests.values()) {
        const key = interest.key;
        if (!families.includes(key.family)) continue;
        if (
          ('scope' in key && key.ownerId === ownerId) ||
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
        s.ownerPrincipalId !== ownerId ||
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
