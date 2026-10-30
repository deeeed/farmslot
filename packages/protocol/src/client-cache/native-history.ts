import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionReadResult,
  NativeSessionTargetParams,
} from '../rpc/native-session.js';
import { Methods } from '../rpc/registry.js';

import { canActOn } from './held-data.js';
import type { ResourceReadStamp } from './keys.js';
import { type ResourceQuery, resourceQuery, type ResourceReadMethod } from './registry.js';
import type { ResourceQueryState, ResourceReadResult } from './types.js';

export interface NativeTimelineEntry {
  key: number;
  kind: 'user' | 'assistant' | 'tool' | 'status';
  event: NativeSessionEvent;
  text: string;
}

export function nativeTimeline(events: NativeSessionEvent[]): NativeTimelineEntry[] {
  const entries: NativeTimelineEntry[] = [];
  const userCommands = new Set<string>();
  const tools = new Map<string, NativeTimelineEntry>();
  const prompts = new Map<string, NativeSessionEvent>();
  for (const event of events) {
    if (
      (event.type === 'command.submitted' || event.type === 'command.accepted') &&
      event.commandId &&
      event.text !== undefined &&
      !prompts.has(event.commandId)
    )
      prompts.set(event.commandId, event);
  }
  for (const event of events) {
    if (event.commandId && !userCommands.has(event.commandId)) {
      const prompt = prompts.get(event.commandId);
      if (prompt) {
        userCommands.add(event.commandId);
        entries.push({ key: prompt.sequence, kind: 'user', event: prompt, text: prompt.text! });
      }
    }
    if (event.type === 'text.delta') {
      const last = entries.at(-1);
      if (
        last?.kind === 'assistant' &&
        last.event.commandId === event.commandId &&
        last.event.generation === event.generation
      ) {
        last.text += event.text ?? '';
      } else
        entries.push({ key: event.sequence, kind: 'assistant', event, text: event.text ?? '' });
    } else if (event.type === 'tool.started' || event.type === 'tool.completed') {
      const identity =
        event.nativeId && JSON.stringify([event.generation, event.commandId, event.nativeId]);
      const previous = identity ? tools.get(identity) : undefined;
      if (previous) {
        const completed = previous.event.type === 'tool.completed' ? previous.event : event;
        const started = event.type === 'tool.started' ? event : previous.event;
        previous.event = {
          ...completed,
          tool: {
            ...started.tool,
            ...completed.tool,
            name: started.tool?.name ?? completed.tool?.name ?? 'Tool',
          },
        };
      } else {
        const entry: NativeTimelineEntry = {
          key: event.sequence,
          kind: 'tool',
          event,
          text: event.tool?.name ?? 'Tool',
        };
        entries.push(entry);
        if (identity) tools.set(identity, entry);
      }
    } else if (['turn.completed', 'session.closed', 'error'].includes(event.type)) {
      entries.push({
        key: event.sequence,
        kind: 'status',
        event,
        text:
          event.text ??
          (event.type === 'session.closed'
            ? `Session ${event.status ?? 'closed'}`
            : event.type === 'error'
              ? 'Runner error'
              : `Turn ${event.status ?? 'completed'}`),
      });
    }
  }
  return entries;
}

/** Client projection metadata. Never sent as a native RPC parameter. */
export interface NativeHistorySnapshot extends NativeSessionReadResult {
  historyRead: { pageReadCount: number; pageAfters: number[] };
}

export const NATIVE_HISTORY_MESSAGES = 200;
export const NATIVE_HISTORY_SESSIONS = 10;

/** One durable observation per opened session/binding, never per cursor page. */
export function nativeHistoryQuery(
  target: NativeSessionTargetParams,
  ownerId: string,
): ResourceQuery<NativeHistorySnapshot> {
  return nativeObservationQuery<NativeHistorySnapshot>(
    Methods.NATIVE_SESSION_READ,
    nativeHistoryParams(target),
    ownerId,
  );
}

export function nativeObservationQuery<T>(
  method: string,
  params: unknown,
  ownerId: string,
): ResourceQuery<T> {
  return resourceQuery<T>(method as ResourceReadMethod, params, ownerId);
}

/** Merge fragments before bounding logical timeline entries. Never slice the raw event tail. */
export function retainNativeMessages(events: NativeSessionEvent[]): NativeSessionEvent[] {
  const timeline = nativeTimeline(events);
  let messages = 0;
  let start = timeline.length;
  while (start > 0 && messages < NATIVE_HISTORY_MESSAGES) {
    start--;
    if (timeline[start].kind === 'user' || timeline[start].kind === 'assistant') messages++;
  }
  let statuses = 0;
  const retained = timeline
    .slice(start)
    .reverse()
    .filter((entry) => entry.kind !== 'status' || ++statuses <= NATIVE_HISTORY_MESSAGES)
    .reverse();
  return retained.map((entry) => ({
    ...entry.event,
    ...(entry.kind === 'assistant' || entry.kind === 'user' ? { text: entry.text } : {}),
  }));
}

export function sameNativeHistoryIdentity(
  a: NativeSessionReadResult,
  b: NativeSessionReadResult,
): boolean {
  const identity = (page: NativeSessionReadResult) =>
    JSON.stringify([
      page.session.id,
      page.session.executionNodeId,
      page.session.ownerPrincipalId,
      page.session.profileId,
      page.session.accountContextId,
      page.session.nativeSessionId,
      page.session.generation,
      page.session.workerLeaseId,
      page.scope?.leaseId,
    ]);
  return identity(a) === identity(b);
}

/** A paged observation can claim only the minimum revision sampled across its pages. */
function intersectStamps(
  a: ResourceReadStamp | undefined,
  b: ResourceReadStamp | undefined,
): ResourceReadStamp | undefined {
  if (!a || !b || a.epoch !== b.epoch) return undefined;
  return {
    epoch: a.epoch,
    dependencies: a.dependencies.flatMap((left) => {
      const right = b.dependencies.find(
        (item) => JSON.stringify(item.key) === JSON.stringify(left.key),
      );
      return right ? [{ key: left.key, revision: Math.min(left.revision, right.revision) }] : [];
    }),
  };
}

export interface NativeHistoryReader {
  (
    params: NativeSessionTargetParams & { after?: number; limit: number },
    signal: AbortSignal,
  ): Promise<ResourceReadResult<NativeSessionReadResult>>;
}

function assertHistoryNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  // Mobile signals support aborted but can lack the newer method and reason.
  if (signal.reason !== undefined) throw signal.reason;
  throw Object.assign(new Error('Native history read aborted.'), { name: 'AbortError' });
}

/** Called inside the existing cache's single in-flight read and authority/store fences.
 * Cursor drains remain read-only. Neither receipts nor pending intents are dispatched here.
 */
export async function readNativeHistory(
  target: NativeSessionTargetParams,
  previous: NativeSessionReadResult | undefined,
  request: NativeHistoryReader,
  signal: AbortSignal,
): Promise<ResourceReadResult<NativeHistorySnapshot>> {
  let retained = previous;
  let cursor = previous?.cursor;
  let stamp: ResourceReadStamp | undefined;
  let first = true;
  const previousRead = (previous as NativeHistorySnapshot | undefined)?.historyRead;
  let pageReadCount = previousRead?.pageReadCount ?? 0;
  let pageAfters = previousRead?.pageAfters ?? [];
  for (let pages = 0; pages < 1000; pages++) {
    assertHistoryNotAborted(signal);
    const reply = await request(
      { ...target, ...(cursor === undefined ? {} : { after: cursor }), limit: 200 },
      signal,
    );
    assertHistoryNotAborted(signal);
    pageReadCount++;
    pageAfters = [...pageAfters.slice(-19), cursor ?? reply.data.scope?.startAfter ?? 0];
    const page = reply.data;
    if (
      page.session.id !== target.sessionId ||
      page.session.executionNodeId !== (target.executionNodeId ?? 'local')
    )
      throw Object.assign(new Error('Native history returned another session or node.'), {
        code: 'NOT_FOUND',
      });
    if (
      target.worker &&
      (page.scope?.leaseId !== target.worker.leaseId ||
        page.session.workerLeaseId !== target.worker.leaseId ||
        page.session.generation !== target.worker.generation)
    )
      throw Object.assign(new Error('Native worker history binding changed.'), {
        code: 'NOT_FOUND',
      });
    if (retained && !sameNativeHistoryIdentity(retained, page)) {
      throw Object.assign(new Error('Native session identity changed. Reopen it explicitly.'), {
        code: 'NOT_FOUND',
      });
    }
    if (
      retained?.scope &&
      page.scope &&
      (retained.scope.startAfter !== page.scope.startAfter ||
        page.scope.endAt < retained.scope.endAt ||
        (retained.scope.released &&
          (!page.scope.released || page.scope.endAt !== retained.scope.endAt)))
    )
      throw Object.assign(new Error('Native task history boundaries changed.'), {
        code: 'NOT_FOUND',
      });
    let next = cursor ?? page.scope?.startAfter ?? 0;
    const fresh: NativeSessionEvent[] = [];
    for (const event of page.events) {
      if (event.sessionId !== target.sessionId)
        throw new Error('Native event belongs to another session.');
      if (event.sequence <= next) continue;
      if (event.sequence !== next + 1) throw new Error('Native history has a gap.');
      next = event.sequence;
      fresh.push(event);
    }
    if (page.cursor !== next || (page.hasMore && next === (cursor ?? page.scope?.startAfter ?? 0)))
      throw new Error('Native history cursor did not advance consistently.');
    stamp = first ? reply.resourceState : intersectStamps(stamp, reply.resourceState);
    first = false;
    retained = { ...page, events: retainNativeMessages([...(retained?.events ?? []), ...fresh]) };
    cursor = page.cursor;
    if (!page.hasMore)
      return {
        data: { ...retained, historyRead: { pageReadCount, pageAfters } },
        resourceState: stamp,
      };
  }
  throw new Error('Native history exceeded the bounded page drain. Retry the read explicitly.');
}

/** Dependencies are scoped to the authenticated reader's authorized native view.
 * The gateway stamps and invalidates these aliases only after handler-level authorization.
 * Cross-node inventories use an explicit owner collection, never a wildcard node.
 */
export function nativeObservationDependencies(method: string, params: unknown, ownerId: string) {
  const target = (params ?? {}) as {
    executionNodeId?: string;
    sessionId?: string;
    worker?: { runId: string };
  };
  if (!ownerId) throw new Error('Native observations require the saved authenticated owner.');
  const profiles =
    method === Methods.NATIVE_PROFILE_LIST || method === Methods.NATIVE_PROFILE_STATUS;
  if (!target.executionNodeId && method !== Methods.NATIVE_SESSION_READ)
    return [
      {
        family: profiles ? ('profiles' as const) : ('native-session' as const),
        scope: 'owner' as const,
        ownerId,
      },
    ];
  const nodeId = target.executionNodeId ?? 'local';
  if (profiles) return [{ family: 'profiles' as const, nodeId, ownerId }];
  return [
    {
      family: 'native-session' as const,
      nodeId,
      ownerId,
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.worker ? { workerId: target.worker.runId } : {}),
    },
  ];
}

/** Reject cursor/limit variants at registration. They belong only to readNativeHistory. */
export function nativeHistoryParams(value: unknown): NativeSessionTargetParams {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native history requires a target.');
  const target = value as NativeSessionTargetParams;
  if (Object.keys(value).some((key) => !['sessionId', 'executionNodeId', 'worker'].includes(key)))
    throw new Error('Native history observations cannot contain cursors or page limits.');
  if (!target.sessionId || typeof target.sessionId !== 'string')
    throw new Error('Native history requires sessionId.');
  if (
    target.worker &&
    ['runId', 'contextId', 'generation', 'leaseId'].some(
      (key) =>
        typeof Reflect.get(target.worker!, key) !== 'string' || !Reflect.get(target.worker!, key),
    )
  )
    throw new Error('Native worker history requires the complete pinned binding.');
  return {
    sessionId: target.sessionId,
    executionNodeId: target.executionNodeId ?? 'local',
    ...(target.worker ? { worker: target.worker } : {}),
  };
}

/** Durable retention counts sessions, while in-memory observation identity keeps the lease pin. */
export function nativeHistoryStorageId(
  query: Pick<ResourceQuery, 'id' | 'method' | 'params'>,
): string {
  if (query.method !== Methods.NATIVE_SESSION_READ) return query.id;
  const target = nativeHistoryParams(query.params);
  return `${Methods.NATIVE_SESSION_READ}:${JSON.stringify({ executionNodeId: target.executionNodeId, sessionId: target.sessionId })}`;
}

export function storedNativeHistoryMatches(
  target: NativeSessionTargetParams,
  value: unknown,
): value is NativeSessionReadResult {
  if (!value || typeof value !== 'object') return false;
  const page = value as NativeSessionReadResult;
  return (
    page.session?.id === target.sessionId &&
    page.session.executionNodeId === (target.executionNodeId ?? 'local') &&
    Array.isArray(page.events) &&
    Number.isSafeInteger(page.cursor) &&
    (!target.worker ||
      (page.scope?.leaseId === target.worker.leaseId &&
        page.session.workerLeaseId === target.worker.leaseId &&
        page.session.generation === target.worker.generation))
  );
}

/**
 * The shared held-data action rule, for the exact history snapshot on screen. Native actions do
 * not reread first, so history restored from storage (no read stamp) waits for a live read.
 */
export function nativeHistoryCanAct(
  observation: ResourceQueryState<NativeSessionReadResult> | undefined,
  rendered: NativeSessionReadResult | undefined,
  connected: boolean,
  now = Date.now(),
): boolean {
  return (
    !!observation?.resourceState &&
    canActOn(observation, connected, now) &&
    !!rendered &&
    observation.data === rendered &&
    !rendered.hasMore
  );
}

export interface NativeTranscript {
  events: NativeSessionEvent[];
  cursor: number;
}

/** Page sequence is authoritative. Ignore repeats; reject a gap rather than hide missing history. */
export function appendNativePage(
  previous: NativeTranscript,
  page: NativeSessionReadResult,
): NativeTranscript {
  const events = [...previous.events];
  let cursor = previous.cursor;
  for (const event of page.events) {
    if (event.sessionId !== page.session.id) throw new Error('Native replay changed session');
    if (event.sequence <= cursor) continue;
    if (event.sequence !== cursor + 1)
      throw new Error('Native history has a gap. Reload this session.');
    events.push(event);
    cursor = event.sequence;
  }
  return cursor === previous.cursor ? previous : { events, cursor };
}

export function nativeDeliveryLabel(receipt?: NativeCommandReceipt): string {
  if (!receipt) return 'Delivery unknown';
  if (receipt.queued) return 'Queued for the next turn';
  if (receipt.outcome === 'interrupted') return 'Interrupted';
  switch (receipt.state) {
    case 'pending':
      return 'Submitting';
    case 'unknown':
      return 'Awaiting runner acceptance';
    case 'accepted':
      return 'Accepted';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
  }
}

/** A confirmed replacement generation must not inherit the old browser input lock. */
export function nativeCommandLockSettled(
  command: { commandId: string; generation: string },
  currentGeneration: string,
  receipt?: NativeCommandReceipt,
  events: NativeSessionEvent[] = [],
): boolean {
  return (
    command.generation !== currentGeneration ||
    (!!receipt &&
      receipt.commandId === command.commandId &&
      receipt.generation === command.generation &&
      ['completed', 'failed'].includes(receipt.state)) ||
    events.some(
      (event) =>
        event.type === 'turn.completed' &&
        event.commandId === command.commandId &&
        event.generation === command.generation,
    )
  );
}

/** A reader within this distance of the end of a conversation follows new output. */
const NATIVE_FOLLOW_SLACK_PX = 80;

export interface NativeFollow {
  /** The reader is at the end, so new output stays in view. */
  following: boolean;
  /** Timeline entries added while the reader was away from the end. */
  unseen: number;
}

/** Opening a conversation, or jumping to its latest entry, follows again. */
export const NATIVE_FOLLOW_LATEST: NativeFollow = { following: true, unseen: 0 };

/** The reader scrolled. Back at the end means caught up. */
export function nativeFollowScrolled(state: NativeFollow, distanceFromEnd: number): NativeFollow {
  if (distanceFromEnd < NATIVE_FOLLOW_SLACK_PX) return NATIVE_FOLLOW_LATEST;
  return state.following ? { following: false, unseen: 0 } : state;
}

/** Entries arrived. A reader away from the end has that many more to catch up on. */
export function nativeFollowGrew(state: NativeFollow, added: number): NativeFollow {
  return state.following || added <= 0 ? state : { ...state, unseen: state.unseen + added };
}

/** The jump control's label, or none while the reader follows. */
export function nativeFollowLabel(state: NativeFollow): string | undefined {
  if (state.following) return undefined;
  return state.unseen ? `Latest · ${state.unseen} new` : 'Latest';
}

const NATIVE_MESSAGE_PREVIEW_LINES = 8;
const NATIVE_MESSAGE_PREVIEW_CHARS = 600;
// A message collapses only when that hides a real amount, never a line or a few characters.
const NATIVE_MESSAGE_COLLAPSE_LINES = 12;
const NATIVE_MESSAGE_COLLAPSE_CHARS = 900;

export interface NativeMessagePreview {
  text: string;
  lines: number;
}

/** A long message (a worker's dispatch prompt) shows its start until the reader expands it. */
export function nativeMessagePreview(text: string): NativeMessagePreview | undefined {
  // A trailing newline is not a line the reader sees.
  const body = text.replace(/\n+$/, '');
  const lines = body.split('\n');
  if (body.length <= NATIVE_MESSAGE_COLLAPSE_CHARS && lines.length <= NATIVE_MESSAGE_COLLAPSE_LINES)
    return undefined;
  const head = lines.slice(0, NATIVE_MESSAGE_PREVIEW_LINES).join('\n');
  if (head.length <= NATIVE_MESSAGE_PREVIEW_CHARS) return { text: head, lines: lines.length };
  // Cut inside a line: mark it, without splitting a surrogate pair.
  const cut = head.slice(0, NATIVE_MESSAGE_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '');
  return { text: `${cut.trimEnd()}…`, lines: lines.length };
}

/** Only the reader's own messages collapse; assistant, tool and status entries show in full. */
export function nativeEntryPreview(entry: NativeTimelineEntry): NativeMessagePreview | undefined {
  return entry.kind === 'user' ? nativeMessagePreview(entry.text) : undefined;
}

export function nativeMessageToggleLabel(preview: NativeMessagePreview, expanded: boolean): string {
  if (expanded) return 'Show less';
  return `Show all · ${preview.lines} ${preview.lines === 1 ? 'line' : 'lines'}`;
}
