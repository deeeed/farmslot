import { randomUUID } from 'node:crypto';

import { NativeConversationJournal } from '@farmslot/agent-runtime/native/conversation';
import type { NativeConversationConnection } from '@farmslot/agent-runtime/native/conversation-ipc';
import {
  Events,
  Methods,
  type NativeConversationCursor,
  type NativeConversationPage,
  type NativeConversationUpdate,
  type NativeSessionDeltaPayload,
  type NativeSessionSubscribeResult,
  type NativeWorkerControlTarget,
  type Principal,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { nativeSessionManager } from '../runners/native/manager.js';
import { resolveNativeExecutionNode } from '../runners/native/node.js';
import {
  nativeWorkerEffectiveSession,
  readNativeWorkerTarget,
} from '../runners/native/worker-history.js';
import { getRun } from '../runs/store.js';
import type { ClientState } from '../server/client-state.js';

import {
  assertNativeObservationAuthority,
  authorizeNativeObservation,
  type NativeInterest,
} from './native-observations.js';
import { resourceRevisions } from './revisions.js';

const MAX_BYTES = 1024 * 1024;
/** Serialized size of each update, measured once and shared by every viewer of its source. */
const updateBytes = new WeakMap<NativeConversationUpdate, number>();
function serializedBytes(update: NativeConversationUpdate): number {
  let bytes = updateBytes.get(update);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(update));
    updateBytes.set(update, bytes);
  }
  return bytes;
}
/** Event frame bytes around a payload of `{...update, subscriptionId}`, plus the prior margin. */
function frameOverhead(subscriptionId: string): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        type: 'event',
        event: Events.NATIVE_SESSION_DELTA,
        payload: { subscriptionId },
      }),
    ) + 64
  );
}
type TerminalReason = Extract<NativeConversationUpdate, { kind: 'terminal' }>['reason'];
interface Source {
  entry: SourceEntry;
  owner: string;
  nodeId: string;
  sessionId: string;
  worker?: NativeWorkerControlTarget;
  node?: ConnectedNode;
  journal: NativeConversationJournal;
  cursor: NativeConversationCursor;
  connection: NativeConversationConnection;
  viewers: Set<Viewer>;
  failed?: TerminalReason;
}
interface SourceEntry {
  key: string;
  pending: Promise<Source>;
  waiters: number;
}
interface Viewer {
  id: string;
  client: ClientState;
  interest: NativeInterest;
  worker?: NativeWorkerControlTarget;
  principal(): Principal;
  readerGeneration: number;
  check(): void;
  source: Source;
  active: boolean;
  closed: boolean;
  draining: boolean;
  queue: NativeConversationUpdate[];
  bytes: number;
  emit(event: string, payload: unknown): void;
}
interface Remote {
  node: ConnectedNode;
  deliver(update: NativeConversationUpdate): void;
}

function readCursor(value: unknown): NativeConversationCursor | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Invalid native conversation cursor');
  const cursor = value as Record<string, unknown>;
  for (const key of ['hostGeneration', 'generation', 'sessionId', 'executionNodeId'])
    if (typeof cursor[key] !== 'string' || !cursor[key])
      throw new GatewayMethodError('INVALID_PARAMS', 'Invalid native conversation cursor');
  if (
    typeof cursor.sequence !== 'number' ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 0
  )
    throw new GatewayMethodError('INVALID_PARAMS', 'Invalid native conversation cursor');
  return {
    hostGeneration: String(cursor.hostGeneration),
    generation: String(cursor.generation),
    sessionId: String(cursor.sessionId),
    executionNodeId: String(cursor.executionNodeId),
    sequence: cursor.sequence,
    ...(cursor.worker !== undefined ? { worker: readNativeWorkerTarget(cursor.worker) } : {}),
  };
}
function sameWorker(a?: NativeWorkerControlTarget, b?: NativeWorkerControlTarget): boolean {
  return (
    a?.runId === b?.runId &&
    a?.contextId === b?.contextId &&
    a?.leaseId === b?.leaseId &&
    a?.generation === b?.generation
  );
}

/** Shared owner-scoped source taps, with current authorization on every recipient. */
export class NativeConversations {
  private sources = new Map<string, SourceEntry>();
  private clients = new Map<ClientState, Map<string, Viewer>>();
  private remotes = new Map<string, Remote>();
  private stopResources?: () => void;

  constructor(private readonly requestNode = sendNodeRequest) {}

  async subscribe(
    client: ClientState,
    value: unknown,
    principal: () => Principal,
    emit: Viewer['emit'],
  ): Promise<NativeSessionSubscribeResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new GatewayMethodError('INVALID_PARAMS', 'Native conversation target required');
    const params = value as Record<string, unknown>;
    if (
      typeof params.sessionId !== 'string' ||
      !params.sessionId.trim() ||
      (params.executionNodeId !== undefined &&
        (typeof params.executionNodeId !== 'string' || !params.executionNodeId.trim()))
    )
      throw new GatewayMethodError('INVALID_PARAMS', 'Invalid native conversation target');
    const allowed = ['sessionId', 'executionNodeId', 'worker', 'after'];
    if (Object.keys(params).some((key) => !allowed.includes(key)))
      throw new GatewayMethodError('INVALID_PARAMS', 'Unexpected native conversation parameters');
    // Validate before acquiring a source. Invalid cursors/pins cannot leak a source tap.
    const after = readCursor(params.after);
    const worker = params.worker === undefined ? undefined : readNativeWorkerTarget(params.worker);
    const reader = principal();
    const nodeId = typeof params.executionNodeId === 'string' ? params.executionNodeId : 'local';
    const interest: NativeInterest = {
      key: {
        family: 'native-session',
        nodeId,
        ownerId: reader.id,
        sessionId: params.sessionId,
        ...(worker ? { workerId: worker.runId } : {}),
      },
      method: Methods.NATIVE_SESSION_READ,
      params: {
        sessionId: params.sessionId,
        executionNodeId: nodeId,
        ...(worker ? { worker } : {}),
      },
    };
    const authority = await authorizeNativeObservation(reader, interest);
    const owner = authority.owners?.[nodeId] ?? authority.ownerId;
    const key = JSON.stringify([
      owner,
      nodeId,
      params.sessionId,
      worker?.leaseId,
      worker?.generation,
    ]);
    let entry = this.sources.get(key);
    if (!entry) {
      // open() yields before any feed can activate; registration precedes its completion.
      const created: SourceEntry = {
        key,
        waiters: 0,
        pending: Promise.resolve().then(() =>
          this.open(created, owner, nodeId, params.sessionId as string, worker),
        ),
      };
      entry = created;
      this.sources.set(key, entry);
    }
    entry.waiters++;
    let source: Source | undefined;
    let registered: Viewer | undefined;
    let returned = false;
    try {
      source = await entry.pending;
      if (source.failed)
        throw new GatewayMethodError('NATIVE_SOURCE_UNAVAILABLE', 'Native source disconnected');
      const session = source.journal.metadata?.session;
      if (!session)
        throw new GatewayMethodError(
          'NATIVE_SOURCE_UNAVAILABLE',
          'Conversation source has no metadata',
        );
      interest.session = session;
      await this.authorize({
        principal,
        interest,
        source,
        readerGeneration: reader.generation ?? 0,
      });
      if (client.ws.readyState !== 1) throw new Error('Conversation client closed');
      const initial = source.journal.resume(sameWorker(after?.worker, worker) ? after : undefined);
      const id = randomUUID();
      const viewer: Viewer = {
        id,
        client,
        interest,
        worker,
        principal,
        readerGeneration: reader.generation ?? 0,
        check: () => {
          throw new Error('Conversation admission incomplete');
        },
        source,
        active: false,
        closed: false,
        draining: false,
        queue: [],
        bytes: 0,
        emit,
      };
      const subscriptions = this.clients.get(client) ?? new Map<string, Viewer>();
      subscriptions.set(id, viewer);
      this.clients.set(client, subscriptions);
      source.viewers.add(viewer);
      registered = viewer;
      this.stopResources ??= resourceRevisions.subscribe((payload) => {
        const runs = new Set(
          payload.changes.flatMap((change) =>
            change.key.family === 'run' ? [change.key.runId] : [],
          ),
        );
        if (!runs.size) return;
        for (const subscriptions of this.clients.values())
          for (const recipient of subscriptions.values())
            if (recipient.worker && runs.has(recipient.worker.runId))
              void this.authorize(recipient).catch(() =>
                this.terminate(recipient, 'access-denied'),
              );
      });
      source.connection.activate();
      viewer.check = await this.authorize(viewer);
      viewer.check();
      returned = true;
      return { ...this.pin(initial, viewer), subscriptionId: id };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND')
        throw new GatewayMethodError('NOT_FOUND', 'Native conversation is unavailable');
      throw error;
    } finally {
      if (registered && !returned) this.unsubscribe(client, registered.id);
      entry.waiters--;
      if (source) this.releaseIfUnused(source);
      else if (!entry.waiters && this.sources.get(key) === entry) this.sources.delete(key);
    }
  }

  activate(client: ClientState, id: string): void {
    const viewer = this.clients.get(client)?.get(id);
    if (!viewer) return;
    viewer.active = true;
    void this.drain(viewer);
  }
  unsubscribe(client: ClientState, id: string): void {
    const viewer = this.clients.get(client)?.get(id);
    if (!viewer) return;
    viewer.closed = true;
    viewer.queue = [];
    viewer.source.viewers.delete(viewer);
    this.clients.get(client)?.delete(id);
    if (!this.clients.get(client)?.size) this.clients.delete(client);
    if (!this.clients.size) {
      this.stopResources?.();
      this.stopResources = undefined;
    }
    this.releaseIfUnused(viewer.source);
  }
  disconnect(client: ClientState): void {
    for (const id of [...(this.clients.get(client)?.keys() ?? [])]) this.unsubscribe(client, id);
  }
  reconcile(): void {
    for (const subscriptions of this.clients.values())
      for (const viewer of subscriptions.values())
        void this.authorize(viewer).catch(() => this.terminate(viewer, 'access-denied'));
  }
  disconnectNode(socket: ConnectedNode['ws']): void {
    for (const [id, remote] of this.remotes)
      if (remote.node.ws === socket) {
        remote.deliver({ kind: 'terminal', reason: 'source-unavailable' });
        this.remotes.delete(id);
      }
  }
  accept(socket: ConnectedNode['ws'], payload: NativeSessionDeltaPayload): void {
    const remote = this.remotes.get(payload.subscriptionId);
    if (!remote || remote.node.ws !== socket) return;
    if (getNode(remote.node.machine) !== remote.node || !remote.node.nativeAuthority?.valid()) {
      remote.deliver({ kind: 'terminal', reason: 'access-denied' });
      return;
    }
    remote.deliver(payload);
  }
  assertCurrent(client: ClientState, id: string): void {
    const viewer = this.clients.get(client)?.get(id);
    if (!viewer || viewer.closed)
      throw new GatewayMethodError(
        'NATIVE_SOURCE_UNAVAILABLE',
        'Conversation source closed before delivery',
      );
    try {
      viewer.check();
    } catch (error) {
      this.unsubscribe(client, id);
      throw error;
    }
  }
  private async authorize(
    viewer: Pick<Viewer, 'principal' | 'interest' | 'source' | 'readerGeneration'>,
  ): Promise<() => void> {
    const principal = viewer.principal();
    const reader = JSON.stringify(principal);
    if ((principal.generation ?? 0) !== viewer.readerGeneration)
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native conversation reader generation changed',
      );
    const authority = await authorizeNativeObservation(principal, viewer.interest);
    const check = () => {
      if (JSON.stringify(viewer.principal()) !== reader)
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native conversation reader changed');
      assertNativeObservationAuthority(authority);
      if (viewer.source.failed)
        throw new GatewayMethodError(
          viewer.source.failed === 'access-denied' ? 'AUTH_FORBIDDEN' : 'NATIVE_SOURCE_UNAVAILABLE',
          'Native conversation source withdrew admission',
        );
      if (
        (authority.owners?.[viewer.source.nodeId] ?? authority.ownerId) !== viewer.source.owner ||
        (viewer.source.node &&
          resolveNativeExecutionNode(viewer.source.owner, viewer.source.nodeId) !==
            viewer.source.node)
      )
        throw new GatewayMethodError(
          'AUTH_FORBIDDEN',
          'Native conversation source authority changed',
        );
    };
    check();
    return check;
  }
  private async open(
    entry: SourceEntry,
    owner: string,
    nodeId: string,
    sessionId: string,
    worker?: NativeWorkerControlTarget,
  ): Promise<Source> {
    let source: Source | undefined;
    const receive = (update: NativeConversationUpdate) => {
      if (!source) throw new Error('Native source delivered before activation');
      if (source.failed) return;
      if (update.kind === 'terminal') {
        this.failSource(source, update.reason);
        return;
      }
      try {
        const previous = source.journal.metadata!;
        const page: NativeConversationPage =
          update.kind === 'reset'
            ? update.snapshot
            : {
                ...previous,
                ...update.page,
                metadataOmitted:
                  update.page.metadataOmitted === null
                    ? undefined
                    : (update.page.metadataOmitted ?? previous.metadataOmitted),
              };
        this.validate(update, owner, nodeId, sessionId, worker, page);
        if (
          source.cursor.hostGeneration !== update.cursor.hostGeneration ||
          source.cursor.generation !== update.cursor.generation
        )
          throw new Error('Native source generation changed');
        if (update.kind === 'reset') source.journal.reset(update.snapshot);
        else {
          if (
            update.page.events.some(
              (event, index) => event.sequence !== source!.journal.sequence + index + 1,
            )
          )
            throw new Error('Native source sequence gap');
          if (update.cursor.sequence < source.journal.sequence)
            throw new Error('Native source cursor regressed');
          source.journal.commit(page);
        }
        source.cursor = update.cursor;
      } catch {
        // A malformed or replaced source is terminal, never a frame for another session.
        this.failSource(source, 'resync-required');
        return;
      }
      for (const viewer of source.viewers) this.enqueue(viewer, update);
    };
    const node = nodeId === 'local' ? undefined : resolveNativeExecutionNode(owner, nodeId);
    const connection = node
      ? await this.openRemote(node, owner, sessionId, receive, worker)
      : await nativeSessionManager.subscribe(
          owner,
          sessionId,
          undefined,
          receive,
          worker?.leaseId,
          worker?.generation,
        );
    try {
      const initial = connection.initial;
      if (initial.kind !== 'reset')
        throw new GatewayMethodError(
          'NATIVE_SOURCE_UNAVAILABLE',
          'Native source cannot supply its bounded initial snapshot',
        );
      this.validate(initial, owner, nodeId, sessionId, worker, initial.snapshot);
      const journal = new NativeConversationJournal(initial.cursor.hostGeneration);
      journal.reset(initial.snapshot);
      source = {
        entry,
        owner,
        nodeId,
        sessionId,
        worker,
        node,
        journal,
        cursor: initial.cursor,
        connection,
        viewers: new Set(),
      };
      return source;
    } catch (error) {
      connection.stop();
      throw error;
    }
  }
  private async openRemote(
    node: ConnectedNode,
    owner: string,
    sessionId: string,
    receive: Remote['deliver'],
    worker?: NativeWorkerControlTarget,
  ): Promise<NativeConversationConnection> {
    if (node.nativeSessions?.conversationStreaming !== 1)
      throw new GatewayMethodError(
        'NATIVE_SOURCE_UNAVAILABLE',
        'Node upgrade required for conversation streaming',
      );
    const id = randomUUID();
    let active = false;
    let stopped = false;
    let bytes = 0;
    let queue: NativeConversationUpdate[] = [];
    // Register the bounded inbox BEFORE requesting. A response and event can share one WS read.
    this.remotes.set(id, {
      node,
      deliver: (update) => {
        if (stopped) return;
        if (active) {
          receive(update);
          return;
        }
        bytes += serializedBytes(update);
        if (bytes > MAX_BYTES) queue = [{ kind: 'terminal', reason: 'resync-required' }];
        else queue.push(update);
      },
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      queue = [];
      this.remotes.delete(id);
      if (getNode(node.machine) !== node || node.ws.readyState !== 1) return;
      void this.requestNode(
        node,
        'native.conversation.unsubscribe',
        { subscriptionId: id },
        { requireSameConnection: true },
      ).catch(() => {
        // An unacknowledged unsubscribe must not leave an orphan source tap. Closing
        // this exact socket invokes the node's stream cleanup, without stopping its host.
        node.ws.close(1011, 'native conversation unsubscribe failed');
      });
    };
    try {
      const initial = (await this.requestNode(
        node,
        'native.conversation.subscribe',
        {
          owner,
          sessionId,
          leaseId: worker?.leaseId,
          generation: worker?.generation,
          subscriptionId: id,
        },
        { requireSameConnection: true },
      )) as NativeConversationUpdate;
      if (initial.kind === 'delta')
        throw new GatewayMethodError(
          'NATIVE_SOURCE_UNAVAILABLE',
          'Native stream omitted its initial reply',
        );
      return {
        initial,
        stop,
        activate() {
          if (active || stopped) return;
          active = true;
          const pending = queue;
          queue = [];
          for (const update of pending) {
            if (stopped) break;
            receive(update);
          }
        },
      };
    } catch (error) {
      stop();
      throw error;
    }
  }
  private validate(
    update: Exclude<NativeConversationUpdate, { kind: 'terminal' }>,
    owner: string,
    nodeId: string,
    id: string,
    worker: NativeWorkerControlTarget | undefined,
    page: NativeConversationPage,
  ): void {
    if (
      !page.session ||
      page.session.ownerPrincipalId !== owner ||
      page.session.id !== id ||
      page.session.executionNodeId !== nodeId ||
      Boolean(page.session.workerManaged) !== Boolean(worker) ||
      (worker &&
        (page.scope?.leaseId !== worker.leaseId ||
          page.session.generation !== worker.generation)) ||
      update.cursor.sessionId !== id ||
      update.cursor.executionNodeId !== nodeId ||
      update.cursor.generation !== page.session.generation ||
      update.cursor.sequence !== page.cursor ||
      page.events.some(
        (event) =>
          event.sessionId !== id ||
          event.sequence > page.cursor ||
          (page.scope && event.sequence <= page.scope.startAfter),
      )
    )
      throw new GatewayMethodError(
        'NATIVE_SOURCE_UNAVAILABLE',
        'Native conversation source identity changed',
      );
  }
  private enqueue(viewer: Viewer, update: NativeConversationUpdate): void {
    if (viewer.closed) return;
    viewer.bytes += serializedBytes(update);
    if (viewer.bytes > MAX_BYTES) {
      this.terminate(viewer, 'resync-required');
      return;
    }
    viewer.queue.push(update);
    if (viewer.active) void this.drain(viewer);
  }
  private async drain(viewer: Viewer): Promise<void> {
    if (viewer.draining || !viewer.active || viewer.closed) return;
    viewer.draining = true;
    try {
      while (viewer.queue.length && !viewer.closed) {
        const check = await this.authorize(viewer);
        if (viewer.closed) return;
        // Nothing below awaits, so this authorization covers every update queued by now, and
        // `check` still re-validates the reader and source before each emit.
        const overhead = frameOverhead(viewer.id);
        while (viewer.queue.length && !viewer.closed) {
          const update = viewer.queue.shift()!;
          const bytes = serializedBytes(update);
          viewer.bytes -= bytes;
          const payload = { ...this.pin(update, viewer), subscriptionId: viewer.id };
          // Only a worker view rewrites the session; otherwise the payload is the update itself.
          const frameBytes =
            (viewer.worker ? Buffer.byteLength(JSON.stringify(payload)) : bytes) + overhead;
          if (viewer.client.ws.bufferedAmount + frameBytes > MAX_BYTES) {
            this.terminate(viewer, 'resync-required');
            return;
          }
          check();
          viewer.emit(Events.NATIVE_SESSION_DELTA, payload);
          if (update.kind === 'terminal') this.unsubscribe(viewer.client, viewer.id);
        }
      }
    } catch {
      this.terminate(viewer, 'access-denied');
    } finally {
      viewer.draining = false;
    }
  }
  private pin<T extends NativeConversationUpdate>(update: T, viewer: Viewer): T {
    if (update.kind === 'terminal') return update;
    const run = viewer.worker && getRun(viewer.worker.runId);
    const effective = (session: NativeConversationPage['session']) =>
      run && viewer.worker
        ? nativeWorkerEffectiveSession(run, viewer.worker.contextId, session)
        : session;
    const body =
      update.kind === 'reset'
        ? { snapshot: { ...update.snapshot, session: effective(update.snapshot.session) } }
        : update.page.session
          ? { page: { ...update.page, session: effective(update.page.session) } }
          : {};
    return {
      ...update,
      ...body,
      cursor: { ...update.cursor, ...(viewer.worker ? { worker: viewer.worker } : {}) },
    };
  }
  private terminate(viewer: Viewer, reason: TerminalReason): void {
    if (viewer.closed) return;
    viewer.queue = [{ kind: 'terminal', reason }];
    viewer.bytes = 0;
    // Wait for initial-response delivery even when the source fails during subscribe.
    if (viewer.active) {
      const terminal = { subscriptionId: viewer.id, kind: 'terminal', reason };
      if (
        viewer.client.ws.bufferedAmount + Buffer.byteLength(JSON.stringify(terminal)) + 256 >
        MAX_BYTES
      )
        viewer.client.ws.close(1013, 'Conversation resync required');
      else viewer.emit(Events.NATIVE_SESSION_DELTA, terminal);
      this.unsubscribe(viewer.client, viewer.id);
    }
  }
  private failSource(source: Source, reason: TerminalReason): void {
    source.failed = reason;
    source.connection.stop();
    for (const viewer of [...source.viewers]) this.terminate(viewer, reason);
    this.releaseIfUnused(source);
  }
  private releaseIfUnused(source: Source): void {
    if (source.viewers.size || source.entry.waiters) return;
    source.connection.stop();
    if (this.sources.get(source.entry.key) === source.entry) this.sources.delete(source.entry.key);
  }
}
export const nativeConversations = new NativeConversations();
