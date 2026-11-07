import { afterForegroundPaint } from '../performance/paint.js';
import type { PerformanceRecorder } from '../performance/recorder.js';
import type { ChatHistoryResult } from '../rpc/chat.js';
import {
  NATIVE_CONVERSATION_LIMITS,
  type NativeConversationCursor,
  type NativeConversationReset,
  type NativeConversationUpdate,
  type NativeSessionDeltaPayload,
  type NativeSessionReadParams,
  type NativeSessionReadResult,
  type NativeSessionSubscribeParams,
  type NativeSessionSubscribeResult,
  type NativeSessionTargetParams,
} from '../rpc/native-session.js';
import { Methods } from '../rpc/registry.js';
import type {
  WorkerSessionHistoryDeltaPayload,
  WorkerSessionHistorySnapshot,
} from '../rpc/worker-session-history.js';
import type { ResourceChangedPayload } from '../transport/events.js';

import { canonicalResourceJson } from './keys.js';
import { storedNativeHistoryMatches } from './native-history.js';
import { resourceQuery } from './registry.js';
import type { GatewayResourceCache, ResourceCacheConnection, ResourceQueryState } from './types.js';

export interface NativeConversationSnapshot extends NativeConversationReset {
  /** Absent only on a migrated offline history. A live reset supplies the real host cursor. */
  streamCursor?: NativeConversationCursor;
  historyRead: { pageReadCount: number; pageAfters: number[] };
  /** Incremental projection accounting; never sent to a runner or gateway. */
  retainedBytes: number;
}
export interface NativeConversationState extends ResourceQueryState<NativeConversationSnapshot> {
  history?: { after: number; loading: boolean; page?: NativeSessionReadResult; error?: string };
}
export interface NativeConversationTransport {
  readPage?(params: NativeSessionReadParams): Promise<NativeSessionReadResult>;
  subscribe(params: NativeSessionSubscribeParams): Promise<NativeSessionSubscribeResult>;
  unsubscribe(subscriptionId: string): Promise<unknown>;
  onDelta(listener: (payload: NativeSessionDeltaPayload) => void): () => void;
}
export interface NativeConversationCache {
  readPage(target: NativeSessionTargetParams, after: number): Promise<void>;
  dismissHistory(target: NativeSessionTargetParams): void;
  observe(
    target: NativeSessionTargetParams,
    listener: (state: NativeConversationState) => void,
  ): () => void;
  read(target: NativeSessionTargetParams): NativeConversationState;
  retry(target: NativeSessionTargetParams): void;
}
interface NativeConversationCacheOptions {
  onEnvelope?: (frame: NativeSessionDeltaPayload) => void;
  performance?: PerformanceRecorder;
  afterPaint?: (paint: () => void) => (() => void) | undefined;
}
interface ConversationStorage {
  load(target: NativeSessionTargetParams): Promise<NativeConversationSnapshot | undefined>;
  save(target: NativeSessionTargetParams, snapshot: NativeConversationSnapshot): Promise<void>;
  forget(target: NativeSessionTargetParams): Promise<void>;
}
interface Entry {
  target: NativeSessionTargetParams;
  state: NativeConversationState;
  listeners: Set<(state: NativeConversationState) => void>;
  ticket: number;
  opening: boolean;
  subscriptionId?: string;
  hydrated: boolean;
  hydrating?: Promise<void>;
  resets: number;
  denialVersion: number;
  metricSource?: 'stored' | 'network';
  paints: Set<() => void>;
}
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const MAX_PROJECTION_BYTES = NATIVE_CONVERSATION_LIMITS.projectionBytes;
const MAX_PENDING_BYTES = 1024 * 1024;
export const NATIVE_CONVERSATION_STORAGE_PREFIX = 'native-conversation:';
export const nativeConversationStorageId = (target: NativeSessionTargetParams) =>
  NATIVE_CONVERSATION_STORAGE_PREFIX +
  canonicalResourceJson({ ...target, executionNodeId: target.executionNodeId ?? 'local' });

function sameCursorSource(
  a: NativeConversationCursor | undefined,
  b: NativeConversationCursor | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.executionNodeId === b.executionNodeId &&
    a.sessionId === b.sessionId &&
    a.hostGeneration === b.hostGeneration &&
    a.generation === b.generation &&
    canonicalResourceJson(a.worker ?? null) === canonicalResourceJson(b.worker ?? null)
  );
}
function snapshotMatches(
  target: NativeSessionTargetParams,
  snapshot: NativeConversationSnapshot,
  cached = false,
): boolean {
  if (!storedNativeHistoryMatches(target, snapshot)) return false;
  const cursor = snapshot.streamCursor;
  return !cursor
    ? cached
    : cursor.sessionId === target.sessionId &&
        cursor.executionNodeId === (target.executionNodeId ?? 'local') &&
        canonicalResourceJson(cursor.worker ?? null) ===
          canonicalResourceJson(target.worker ?? null);
}

/** One reducer for web, Companion and CLI. Input is normalized native events, never runner text. */
export function reduceNativeConversation(
  previous: NativeConversationSnapshot | undefined,
  update: Exclude<NativeConversationUpdate, { kind: 'terminal' }>,
): NativeConversationSnapshot {
  if (update.kind === 'reset' || (!previous && update.kind === 'replay')) {
    const snapshot =
      update.kind === 'reset'
        ? update.snapshot
        : {
            ...update.page,
            historyBefore: (update.page.events[0]?.sequence ?? update.cursor.sequence + 1) - 1,
            truncated: true,
          };
    return {
      ...snapshot,
      streamCursor: update.cursor,
      retainedBytes: snapshot.events.reduce((total, event) => total + bytes(event), 0),
      historyRead: { pageReadCount: 0, pageAfters: [] },
    };
  }
  if (!previous || !sameCursorSource(previous.streamCursor, update.cursor))
    throw new Error('Conversation source changed without a reset');
  if (update.cursor.sequence < previous.cursor) return previous;
  let cursor = previous.cursor;
  const events = [...previous.events];
  const omissions = previous.omissions?.map((item) => ({ ...item })) ?? [];
  let retainedBytes = previous.retainedBytes;
  let historyBefore = previous.historyBefore;
  for (const event of update.page.events) {
    if (event.sequence <= cursor) continue;
    if (event.sequence !== cursor + 1 || event.sessionId !== update.cursor.sessionId)
      throw new Error('Conversation event gap');
    cursor = event.sequence;
    const last = events.at(-1);
    if (
      event.type === 'text.delta' &&
      last?.type === 'text.delta' &&
      event.commandId === last.commandId &&
      event.generation === last.generation
    ) {
      const added = bytes(event.text ?? '') - 2;
      const omitted = omissions.find((item) => item.anchorSequence === last.sequence);
      if (omitted) omitted.through = event.sequence;
      else if (retainedBytes + added > MAX_PROJECTION_BYTES) {
        omissions.push({
          anchorSequence: last.sequence,
          after: event.sequence - 1,
          through: event.sequence,
        });
      } else {
        events[events.length - 1] = { ...last, text: (last.text ?? '') + (event.text ?? '') };
        retainedBytes += added;
      }
    } else {
      events.push(event);
      retainedBytes += bytes(event);
    }
    while (
      (retainedBytes > MAX_PROJECTION_BYTES ||
        events.length > NATIVE_CONVERSATION_LIMITS.projectionRows) &&
      events.length > 1
    ) {
      const removed = events.shift()!;
      retainedBytes -= bytes(removed);
      historyBefore = events[0].sequence - 1;
      const omission = omissions.findIndex((item) => item.anchorSequence === removed.sequence);
      if (omission >= 0) omissions.splice(omission, 1);
    }
  }
  if (cursor !== update.cursor.sequence) throw new Error('Conversation high-water gap');
  const page = update.page;
  const { metadataOmitted: _omitted, ...changes } = page;
  return {
    ...previous,
    ...changes,
    events,
    hasMore: false,
    retainedBytes,
    cursor,
    streamCursor: update.cursor,
    omissions,
    historyBefore,
    metadataOmitted:
      page.metadataOmitted === null
        ? undefined
        : (page.metadataOmitted ?? previous.metadataOmitted),
    truncated:
      historyBefore > (page.scope?.startAfter ?? previous.scope?.startAfter ?? 0) ||
      omissions.length > 0,
  };
}

/** Scoped-store owner calls connectionChanged synchronously with its own authority fence. */
export function createNativeConversationCache(
  transport: NativeConversationTransport | undefined,
  storage: ConversationStorage,
  connection: () => ResourceCacheConnection,
  options: NativeConversationCacheOptions = {},
) {
  const metrics = options.performance;
  const entries = new Map<string, Entry>();
  const byId = new Map<string, Entry>();
  let disposed = false;
  let admitted = true;
  let epoch = 0;
  let pending = 0;
  let early: NativeSessionDeltaPayload[] = [];
  let earlyBytes = 0;
  let overflowVersion = 0;
  const notify = (entry: Entry) => {
    for (const listener of entry.listeners) listener(entry.state);
  };
  const entryFor = (target: NativeSessionTargetParams): Entry => {
    const key = nativeConversationStorageId(target);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        target,
        state: { status: 'loading' },
        listeners: new Set(),
        ticket: 0,
        opening: false,
        hydrated: false,
        resets: 0,
        denialVersion: 0,
        paints: new Set(),
      };
      entries.set(key, entry);
    }
    return entry;
  };
  const failure = (entry: Entry, error: unknown) => {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'NATIVE_SOURCE_UNAVAILABLE';
    const denied = ['AUTH_FORBIDDEN', 'AUTH_REQUIRED', 'NOT_FOUND'].includes(code);
    entry.state = {
      ...(denied ? {} : entry.state),
      status: entry.state.data && !denied ? 'stale' : 'error',
      error: { code, message: error instanceof Error ? error.message : String(error) },
    };
    if (denied) {
      entry.denialVersion++;
      entry.hydrated = true;
      void storage.forget(entry.target).catch((error) => storageFailed(entry, error));
    }
    notify(entry);
  };
  const storageFailed = (entry: Entry, error: unknown) => {
    entry.state = {
      ...entry.state,
      storageNotice: `Conversation cache failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    notify(entry);
  };
  const save = (entry: Entry): Promise<void> =>
    entry.state.data
      ? storage.save(entry.target, entry.state.data).catch((error) => storageFailed(entry, error))
      : Promise.resolve();
  const detach = (entry: Entry) => {
    entry.ticket++;
    entry.opening = false;
    for (const cancel of entry.paints) cancel();
    entry.paints.clear();
    const { conversation: _authority, ...held } = entry.state;
    entry.state = { ...held, status: held.data ? 'stale' : held.status };
    notify(entry);
    const detachedEpoch = epoch;
    const detachedTicket = entry.ticket;
    const id = entry.subscriptionId;
    entry.subscriptionId = undefined;
    if (![...entries.values()].some((value) => value.subscriptionId || value.opening)) {
      stopDelta?.();
      stopDelta = undefined;
    }
    if (id) {
      byId.delete(id);
      void transport?.unsubscribe(id).catch((error) => {
        if (!disposed && epoch === detachedEpoch && entry.ticket === detachedTicket)
          failure(entry, error);
      });
    }
  };
  function apply(
    entry: Entry,
    update: NativeConversationUpdate,
    envelope?: NativeSessionDeltaPayload,
  ): void {
    const received = metrics?.clock();
    const metricEpoch = metrics?.epoch;
    if (update.kind === 'terminal') {
      if (envelope) options.onEnvelope?.(envelope);
      else if (entry.subscriptionId)
        options.onEnvelope?.({ ...update, subscriptionId: entry.subscriptionId });
      detach(entry);
      if (update.reason === 'resync-required') {
        resync(entry);
        return;
      }
      if (update.reason === 'source-unavailable') {
        resync(entry, false);
        return;
      }
      failure(
        entry,
        Object.assign(
          new Error(
            update.reason === 'access-denied'
              ? 'Conversation access was withdrawn'
              : 'Conversation source unavailable',
          ),
          {
            code:
              update.reason === 'access-denied' ? 'AUTH_FORBIDDEN' : 'NATIVE_SOURCE_UNAVAILABLE',
          },
        ),
      );
      return;
    }
    let data: NativeConversationSnapshot;
    try {
      data = reduceNativeConversation(entry.state.data, update);
      if (!snapshotMatches(entry.target, data)) throw new Error('Conversation target changed');
    } catch {
      detach(entry);
      resync(entry);
      return;
    }
    const previousState = entry.state.data?.session.state;
    entry.metricSource = 'network';
    if (update.kind === 'delta' && update.page.events.length) entry.resets = 0;
    const history =
      entry.state.data && sameCursorSource(entry.state.data.streamCursor, data.streamCursor)
        ? entry.state.history
        : undefined;
    entry.state = {
      status: 'ready',
      data,
      history,
      observedAt: Date.now(),
      conversation: data.streamCursor,
    };
    if (envelope) options.onEnvelope?.(envelope);
    notify(entry);
    if (
      metrics &&
      received !== undefined &&
      update.kind === 'delta' &&
      update.page.events.some((event) => event.type === 'text.delta') &&
      connection().foreground !== false
    ) {
      let cancel: (() => void) | undefined;
      cancel = (options.afterPaint ?? afterForegroundPaint)(() => {
        if (cancel) entry.paints.delete(cancel);
        if (
          !disposed &&
          entry.listeners.size &&
          metrics.epoch === metricEpoch &&
          connection().foreground !== false
        )
          metrics.observe(
            'farmslot_native_text_render_seconds',
            {
              method: Methods.NATIVE_SESSION_SUBSCRIBE,
              cache_source: 'network',
              action_class: 'interactive-read',
            },
            metrics.clock() - received,
          );
      });
      if (cancel) entry.paints.add(cancel);
    }
    if (update.kind === 'reset' || data.session.state !== previousState) void save(entry);
  }

  function resync(entry: Entry, reset = true): void {
    if (++entry.resets > 2) {
      failure(entry, new Error('Conversation needs an explicit retry after repeated source gaps'));
      return;
    }
    void open(entry, reset);
  }
  let stopDelta: (() => void) | undefined;
  function receiveDelta(payload: NativeSessionDeltaPayload): void {
    const entry = byId.get(payload.subscriptionId);
    if (entry) {
      apply(entry, payload, payload);
      return;
    }
    if (!pending) return;
    earlyBytes += bytes(payload);
    if (earlyBytes > MAX_PENDING_BYTES) {
      overflowVersion++;
      earlyBytes = 0;
      early = [];
    } else early.push(payload);
  }
  function armDelta(): void {
    stopDelta ??= transport?.onDelta(receiveDelta);
  }
  async function open(entry: Entry, reset = false): Promise<void> {
    const current = connection();
    if (
      disposed ||
      !admitted ||
      entry.opening ||
      entry.subscriptionId ||
      !entry.listeners.size ||
      !current.connected ||
      current.foreground === false
    )
      return;
    if (!transport || current.capabilities?.conversationStreaming !== 1) {
      entry.state = {
        ...entry.state,
        status: 'unsupported',
        error: {
          code: 'NATIVE_SOURCE_UNAVAILABLE',
          message: 'Update the gateway, node and native host for conversation streaming',
        },
      };
      notify(entry);
      return;
    }
    armDelta();
    const ticket = ++entry.ticket;
    const openedEpoch = epoch;
    const openedOverflow = overflowVersion;
    entry.opening = true;
    pending++;
    try {
      metrics?.reread(Methods.NATIVE_SESSION_SUBSCRIBE, entry);
      const result = await transport.subscribe({
        ...entry.target,
        ...(!reset && entry.state.data ? { after: entry.state.data.streamCursor } : {}),
      });
      if (
        disposed ||
        epoch !== openedEpoch ||
        ticket !== entry.ticket ||
        !entry.listeners.size ||
        !connection().connected ||
        connection().foreground === false
      ) {
        await transport.unsubscribe(result.subscriptionId);
        return;
      }
      entry.subscriptionId = result.subscriptionId;
      byId.set(result.subscriptionId, entry);
      const wasOverflow = overflowVersion !== openedOverflow;
      const frames = early.filter((item) => item.subscriptionId === result.subscriptionId);
      early = early.filter((item) => item.subscriptionId !== result.subscriptionId);
      earlyBytes = early.reduce((total, item) => total + bytes(item), 0);
      apply(entry, result, result);
      if (wasOverflow) apply(entry, { kind: 'terminal', reason: 'resync-required' });
      else
        for (const payload of frames)
          if (entry.subscriptionId === result.subscriptionId) apply(entry, payload, payload);
    } catch (error) {
      if (epoch === openedEpoch && entry.ticket === ticket) failure(entry, error);
    } finally {
      if (entry.ticket === ticket) entry.opening = false;
      pending--;
      if (!pending) {
        early = [];
        earlyBytes = 0;
      }
    }
  }
  async function hydrate(entry: Entry): Promise<void> {
    const ticket = epoch;
    const denialVersion = entry.denialVersion;
    try {
      const saved = await storage.load(entry.target);
      if (disposed || ticket !== epoch || denialVersion !== entry.denialVersion) return;
      if (!entry.state.data && saved && snapshotMatches(entry.target, saved, true)) {
        entry.metricSource = 'stored';
        entry.state = { status: 'stale', data: saved };
        notify(entry);
      }
      entry.hydrated = true;
      void open(entry);
    } catch (error) {
      if (ticket !== epoch || disposed || denialVersion !== entry.denialVersion) return;
      storageFailed(entry, error);
      entry.hydrated = true;
      void open(entry);
    }
  }
  const api: NativeConversationCache = {
    async readPage(target, after) {
      const entry = entryFor(target);
      if (
        entry.state.status !== 'ready' ||
        !entry.subscriptionId ||
        !transport?.readPage ||
        !entry.state.data
      )
        throw new Error('Wait for the current conversation before paging its journal');
      const source = entry.state.data;
      const ticket = entry.ticket,
        readingEpoch = epoch;
      const request = { after, loading: true };
      entry.state = { ...entry.state, history: request };
      notify(entry);
      const current = () =>
        !disposed &&
        entry.ticket === ticket &&
        epoch === readingEpoch &&
        entry.state.history === request;
      try {
        const page = await transport.readPage({ ...target, after, limit: 200 });
        if (!current()) return;
        if (
          !storedNativeHistoryMatches(target, page) ||
          page.session.ownerPrincipalId !== source.session.ownerPrincipalId ||
          page.session.generation !== source.session.generation
        )
          throw new Error('Historical page source changed');
        const data =
          entry.state.data === source && source.metadataOmitted?.pendingRequests
            ? {
                ...source,
                pendingRequests: page.pendingRequests,
                metadataOmitted: source.metadataOmitted.commands
                  ? { commands: source.metadataOmitted.commands, pendingRequests: 0 }
                  : undefined,
              }
            : entry.state.data;
        entry.state = { ...entry.state, data, history: { after, loading: false, page } };
        notify(entry);
      } catch (error) {
        if (current()) {
          const code =
            error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (code === 'AUTH_FORBIDDEN' || code === 'AUTH_REQUIRED' || code === 'NOT_FOUND') {
            detach(entry);
            failure(entry, error);
            return;
          }
          entry.state = {
            ...entry.state,
            history: {
              after,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
          notify(entry);
        }
      }
    },
    dismissHistory(target) {
      const entry = entryFor(target);
      entry.state = { ...entry.state, history: undefined };
      notify(entry);
    },
    observe(target, listener) {
      if (disposed) throw new Error('Conversation cache is disposed');
      const entry = entryFor(target);
      const held = entry.state.data !== undefined;
      const started = metrics?.clock(),
        metricEpoch = metrics?.epoch;
      let first = true,
        active = true;
      let cancelPaint: (() => void) | undefined;
      const receive = (state: NativeConversationState) => {
        listener(state);
        if (!first || !state.data || !metrics || started === undefined) return;
        first = false;
        const source = held ? 'memory' : (entry.metricSource ?? 'unknown');
        metrics.increment('farmslot_client_cache_reads_total', {
          method: Methods.NATIVE_SESSION_SUBSCRIBE,
          cache_source: source,
        });
        cancelPaint = (options.afterPaint ?? afterForegroundPaint)(() => {
          if (cancelPaint) entry.paints.delete(cancelPaint);
          if (
            !active ||
            disposed ||
            metrics.epoch !== metricEpoch ||
            connection().foreground === false
          )
            return;
          metrics.observe(
            source === 'network'
              ? 'farmslot_client_visible_read_seconds'
              : 'farmslot_client_cached_paint_seconds',
            {
              method: Methods.NATIVE_SESSION_SUBSCRIBE,
              cache_source: source,
              action_class: source === 'network' ? 'interactive-read' : 'cached-paint',
            },
            metrics.clock() - started,
          );
        });
        if (cancelPaint) entry.paints.add(cancelPaint);
        else
          metrics.increment('farmslot_client_unmeasured_paints_total', {
            method: Methods.NATIVE_SESSION_SUBSCRIBE,
          });
      };
      entry.listeners.add(receive);
      receive(entry.state);
      if (!entry.hydrated) {
        if (!entry.hydrating)
          entry.hydrating = hydrate(entry).finally(() => {
            entry.hydrating = undefined;
          });
      } else void open(entry);
      return () => {
        active = false;
        cancelPaint?.();
        if (cancelPaint) entry.paints.delete(cancelPaint);
        entry.listeners.delete(receive);
        if (!entry.listeners.size) {
          void save(entry);
          detach(entry);
        }
        const inactive = [...entries].filter(([, value]) => !value.listeners.size);
        for (const [key] of inactive.slice(0, Math.max(0, inactive.length - 10)))
          entries.delete(key);
      };
    },
    read(target) {
      return entryFor(target).state;
    },
    retry(target) {
      const entry = entryFor(target);
      entry.resets = 0;
      detach(entry);
      void open(entry);
    },
  };
  return {
    api,
    resourcesChanged(payload: ResourceChangedPayload): void {
      for (const entry of entries.values()) {
        if (!entry.listeners.size || entry.subscriptionId || entry.opening) continue;
        const relevant = payload.changes.some(({ key }) =>
          entry.target.worker
            ? key.family === 'run' && key.runId === entry.target.worker!.runId
            : (key.family === 'copilot' && (entry.target.executionNodeId ?? 'local') === 'local') ||
              (key.family === 'native-session' &&
                ('scope' in key ||
                  (key.nodeId === (entry.target.executionNodeId ?? 'local') &&
                    (!key.sessionId || key.sessionId === entry.target.sessionId)))),
        );
        if (relevant) {
          entry.resets = 0;
          void open(entry);
        }
      }
    },
    connectionChanged(withdraw: boolean, resume = true) {
      epoch++;
      admitted = resume;
      early = [];
      earlyBytes = 0;
      for (const entry of entries.values()) {
        if (!withdraw) void save(entry);
        else entry.state = { status: 'loading' };
        detach(entry);
        entry.state = withdraw ? { status: 'loading' } : { ...entry.state, status: 'stale' };
        if (withdraw) entry.hydrated = false;
        notify(entry);
        if (resume && entry.listeners.size) {
          if (!entry.hydrated) void hydrate(entry);
          else void open(entry);
        }
      }
    },
    async dispose(withdraw: boolean): Promise<void> {
      if (disposed) return;
      const saves = [...entries.values()].map((entry) => {
        const saving = withdraw ? Promise.resolve() : save(entry);
        if (withdraw) entry.state = { status: 'loading' };
        detach(entry);
        return saving;
      });
      disposed = true;
      epoch++;
      stopDelta?.();
      entries.clear();
      byId.clear();
      await Promise.all(saves);
    },
  };
}

/** Shared public entry; metadata resource observers never own the conversation body. */
export function observeNativeConversation(
  cache: { conversations?: NativeConversationCache },
  target: NativeSessionTargetParams,
  listener: (state: NativeConversationState) => void,
): () => void {
  if (!cache.conversations) {
    listener({
      status: 'unsupported',
      error: {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
        message: 'Conversation streaming is unavailable',
      },
    });
    return () => undefined;
  }
  return cache.conversations.observe(target, listener);
}

/** Immutable pre-native histories share the scoped store, without a mutable chat facade. */
export function observeLegacyConversation(
  cache: Pick<GatewayResourceCache, 'observe'>,
  sessionId: string,
  listener: (state: ResourceQueryState<ChatHistoryResult>) => void,
): () => void {
  return cache.observe(
    resourceQuery<ChatHistoryResult>(Methods.CHAT_ARCHIVE, { sessionId }),
    listener,
  );
}

export function nativeConversationOmissionNotice(
  snapshot: Partial<NativeConversationReset> | undefined,
): string {
  if (snapshot?.metadataOmitted?.pendingRequests)
    return 'Some request details need an explicit journal read. Input waits for complete request metadata.';
  if (snapshot?.truncated || snapshot?.metadataOmitted?.commands)
    return 'Additional output is available in the saved journal.';
  return '';
}

/** Legacy completed-message rows keep their original identities. Never turn TUI output into native events. */
export function applyLegacyConversationDelta(
  previous: WorkerSessionHistorySnapshot,
  payload: WorkerSessionHistoryDeltaPayload,
  selection: { slotId?: string; runId?: string },
): WorkerSessionHistorySnapshot {
  if (
    (selection.slotId && payload.slotId !== selection.slotId) ||
    (selection.runId && payload.runId !== selection.runId)
  )
    return previous;
  const retarget = payload.reset === true && !selection.runId && payload.runId !== previous.runId;
  if (
    !retarget &&
    (payload.runId !== previous.runId ||
      payload.role !== previous.role ||
      payload.contextId !== previous.contextId)
  )
    return previous;
  const messages = payload.reset
    ? payload.messages
    : [...previous.messages, ...payload.messages].slice(-300);
  return {
    ...previous,
    runId: payload.runId,
    role: payload.role,
    contextId: payload.contextId,
    runner: payload.runner,
    model: payload.model ?? previous.model,
    runnerSessionPath: payload.runnerSessionPath ?? previous.runnerSessionPath,
    source: payload.source,
    messages,
    cursor: payload.cursor,
    degradedReason: payload.degradedReason,
    generatedAt: payload.generatedAt,
  };
}
