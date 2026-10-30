import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionReadResult,
  NativeSessionResponse,
  NativeSessionTargetParams,
  NativeSessionTool,
  NativeToolKind,
} from '../rpc/native-session.js';
import { Methods } from '../rpc/registry.js';

import { canActOn } from './held-data.js';
import type { ResourceReadStamp } from './keys.js';
import { type ResourceQuery, resourceQuery, type ResourceReadMethod } from './registry.js';
import { terminalLinesFromText } from './terminal-text.js';
import type { ResourceQueryState, ResourceReadResult } from './types.js';

export interface NativeTimelineEntry {
  key: number;
  kind: 'user' | 'assistant' | 'tool' | 'resolution' | 'status';
  event: NativeSessionEvent;
  text: string;
}

export function nativeTimeline(events: NativeSessionEvent[]): NativeTimelineEntry[] {
  const entries: NativeTimelineEntry[] = [];
  const userCommands = new Set<string>();
  const tools = new Map<string, NativeTimelineEntry>();
  const prompts = new Map<string, NativeSessionEvent>();
  for (const event of events) {
    if (nativePrompt(event) && !prompts.has(event.commandId)) prompts.set(event.commandId, event);
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
        // Keep the entry's sequence: cached history keeps only this merged event, and the next read
        // keys the tool by it, so a card the reader opened stays the same card when it finishes.
        previous.event = {
          ...completed,
          sequence: previous.key,
          tool: {
            ...started.tool,
            ...completed.tool,
            name: started.tool?.name ?? completed.tool?.name ?? 'Tool',
          },
        };
        // A runner can name the command or files only after the call started (Cursor does).
        previous.text = nativeToolLabel(previous.event.tool);
      } else {
        const entry: NativeTimelineEntry = {
          key: event.sequence,
          kind: 'tool',
          event,
          text: nativeToolLabel(event.tool),
        };
        entries.push(entry);
        if (identity) tools.set(identity, entry);
      }
    } else if (event.type === 'approval.resolved' && event.request) {
      entries.push({
        key: event.sequence,
        kind: 'resolution',
        event,
        text: nativeResolutionText(event.request, event.response),
      });
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

/**
 * "Approved: rm -r build", "Declined: …", "Answered: Which file? → a.ts", or "Resolved: …" when
 * the host did not deliver the response (the runner resolved it), so the decision is unknown.
 */
function nativeResolutionText(
  request: NonNullable<NativeSessionEvent['request']>,
  response: NativeSessionResponse | undefined,
): string {
  const questions = request.questions ?? [];
  const answered = questions.flatMap((question) => {
    const answer = response?.answers?.[question.id];
    return answer?.length ? [`${question.prompt} → ${answer.join(', ')}`] : [];
  });
  if (answered.length) return `Answered: ${answered.join('; ')}`;
  const subject = questions.length
    ? questions.map((question) => question.prompt).join('; ')
    : (request.detail ?? request.tool?.name ?? request.title);
  const outcome =
    response?.decision === 'approve'
      ? 'Approved'
      : response?.decision === 'deny'
        ? 'Declined'
        : 'Resolved';
  return `${outcome}: ${subject}`;
}

/** Client projection metadata. Never sent as a native RPC parameter. */
export interface NativeHistorySnapshot extends NativeSessionReadResult {
  historyRead: { pageReadCount: number; pageAfters: number[]; projection?: number };
}

/** Bumped when retention keeps more: a snapshot saved by an older reader is read again from its start, once. */
const NATIVE_HISTORY_PROJECTION = 3;

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
  const kept = retained.map((entry) => ({
    ...entry.event,
    ...(entry.kind === 'assistant' || entry.kind === 'user' ? { text: entry.text } : {}),
  }));
  // A running turn's start is not a timeline entry, but its working time is counted from it.
  // Appended: the timeline skips it and nativeWork compares sequences, so its place does not
  // matter, and sorting would move tool cards that finished out of order.
  const turn = nativeOpenTurn(events);
  if (!turn || kept.some((item) => item.sequence === turn.sequence)) return kept;
  return [...kept, turn];
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
  const previousRead = (previous as NativeHistorySnapshot | undefined)?.historyRead;
  // Saved by a reader that dropped the running turn's start: keep its identity, reread its events.
  const replay =
    previousRead !== undefined && previousRead.projection !== NATIVE_HISTORY_PROJECTION;
  let retained = previous && replay ? { ...previous, events: [] } : previous;
  let cursor = replay ? undefined : previous?.cursor;
  let stamp: ResourceReadStamp | undefined;
  let first = true;
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
        data: {
          ...retained,
          historyRead: { pageReadCount, pageAfters, projection: NATIVE_HISTORY_PROJECTION },
        },
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

/** Current, complete history under the shared held-data rule. */
function nativeHistoryCurrent(
  observation: ResourceQueryState<NativeSessionReadResult> | undefined,
  connected: boolean,
  now: number,
): observation is ResourceQueryState<NativeSessionReadResult> & { data: NativeSessionReadResult } {
  return (
    !!observation?.resourceState &&
    canActOn(observation, connected, now) &&
    !!observation.data &&
    !observation.data.hasMore
  );
}

/**
 * Sending a message: current, complete history of the conversation on screen. A newer read of it,
 * landing while a turn streams, does not refuse the message; a resumed generation, another worker
 * lease or a released task scope does. Native actions do not reread first, so history restored from
 * storage (no read stamp) waits for a live read.
 */
export function nativeHistoryCanSend(
  observation: ResourceQueryState<NativeSessionReadResult> | undefined,
  rendered: NativeSessionReadResult | undefined,
  connected: boolean,
  now = Date.now(),
): boolean {
  return (
    nativeHistoryCurrent(observation, connected, now) &&
    !!rendered &&
    sameNativeHistoryIdentity(observation.data, rendered) &&
    !observation.data.scope?.released
  );
}

/** An answer or stop acts on the exact history snapshot on screen. */
export function nativeHistoryCanAct(
  observation: ResourceQueryState<NativeSessionReadResult> | undefined,
  rendered: NativeSessionReadResult | undefined,
  connected: boolean,
  now = Date.now(),
): boolean {
  return nativeHistoryCurrent(observation, connected, now) && observation.data === rendered;
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

/**
 * The composer's send action for a session in this state: "Send" when it is idle, "Queue message"
 * for the next turn while a turn runs or waits on a request. Undefined: it takes no input now.
 */
export function nativeSendLabel(
  state: NativeSessionReadResult['session']['state'] | undefined,
): 'Send' | 'Queue message' | undefined {
  if (state === 'idle') return 'Send';
  if (state === 'running' || state === 'waiting') return 'Queue message';
  return undefined;
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

/** A sent message the timeline shows: its submission or acceptance, with the message text. */
function nativePrompt(
  event: NativeSessionEvent,
): event is NativeSessionEvent & { commandId: string; text: string } {
  return (
    (event.type === 'command.submitted' || event.type === 'command.accepted') &&
    !!event.commandId &&
    event.text !== undefined
  );
}

/**
 * Whether the timeline shows the message sent as `commandId`. Until it does, a
 * client shows the message itself, with its delivery state.
 */
export function nativeMessageShown(events: NativeSessionEvent[], commandId: string): boolean {
  return events.some((event) => event.commandId === commandId && nativePrompt(event));
}

/**
 * Whether the host failed a sent message before the conversation showed it, as it does
 * with a queued message when the session closes or its worker lease changes. Nothing
 * else keeps that text, so a client gives it back to the reader.
 */
export function nativeMessageDropped(
  events: NativeSessionEvent[],
  commandId: string,
  receipt?: NativeCommandReceipt,
): boolean {
  return receipt?.state === 'failed' && !nativeMessageShown(events, commandId);
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
  return { text: nativeClip(head, NATIVE_MESSAGE_PREVIEW_CHARS), lines: lines.length };
}

/** At most `max` characters, then "…" where it was cut, never splitting a surrogate pair. */
function nativeClip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()}…`;
}

/** Only the reader's own messages collapse; assistant, tool and status entries show in full. */
export function nativeEntryPreview(entry: NativeTimelineEntry): NativeMessagePreview | undefined {
  return entry.kind === 'user' ? nativeMessagePreview(entry.text) : undefined;
}

export function nativeMessageToggleLabel(preview: NativeMessagePreview, expanded: boolean): string {
  if (expanded) return 'Show less';
  return `Show all · ${preview.lines} ${preview.lines === 1 ? 'line' : 'lines'}`;
}

export interface NativeWork {
  /** When the open turn started, in ms. */
  since: number;
  /** The tool the turn is running now. */
  tool?: string;
}

/** The start of the turn still running, if any. A restarted host cannot continue a turn. */
function nativeOpenTurn(events: NativeSessionEvent[]): NativeSessionEvent | undefined {
  let turn: NativeSessionEvent | undefined;
  for (const event of events) {
    if (event.type === 'turn.started') turn = event;
    else if (['turn.completed', 'session.closed', 'session.started'].includes(event.type))
      turn = undefined;
  }
  return turn;
}

/** The turn in progress, if any: when it started and the tool it is running now. */
export function nativeWork(events: NativeSessionEvent[]): NativeWork | undefined {
  const turn = nativeOpenTurn(events);
  if (!turn) return undefined;
  const tools = new Map<string, string>();
  for (const event of events) {
    if (event.sequence <= turn.sequence || !event.nativeId || !event.tool) continue;
    if (event.type === 'tool.started') tools.set(event.nativeId, nativeToolLabel(event.tool));
    else if (event.type === 'tool.completed') tools.delete(event.nativeId);
  }
  return { since: Date.parse(turn.at), tool: [...tools.values()].at(-1) };
}

/**
 * "Working · 1m 12s · Bash": how long the turn has run, and its current tool.
 * `since` is the execution host's clock: a client clock ahead of it overstates the time by the skew.
 */
export function nativeWorkLabel(work: NativeWork, now: number): string {
  return `Working · ${nativeElapsed(now - work.since)}${work.tool ? ` · ${work.tool}` : ''}`;
}

/** "12s", "1m 12s", "1h 3m". */
function nativeElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

const NATIVE_TOOL_LABEL_CHARS = 120;
const NATIVE_TOOL_LABEL_FILES = 3;
// Fits a tool card's box without scrolling, so the end of the output is what the reader sees.
const NATIVE_TOOL_OUTPUT_LINES = 10;
const NATIVE_COMMAND_CHARS = 200;
// "Change", not "Edit": the kind also covers creating, deleting and moving a file.
const NATIVE_TOOL_VERBS: Partial<Record<NativeToolKind, string>> = {
  command: 'Run',
  'file-edit': 'Change',
  'file-read': 'Read',
  search: 'Search',
};

/**
 * A tool call as a reader reads it: "Run npm test", "Change a.ts, b.ts", "Read a.ts", "Search src",
 * at most 120 characters before an ellipsis. A tool whose adapter gave no kind or subject keeps the
 * runner's own name.
 */
export function nativeToolLabel(tool: NativeSessionTool | undefined): string {
  if (!tool) return 'Tool';
  const names = (tool.paths ?? []).map(
    (path) => path.replace(/\/+$/, '').split('/').at(-1) || path,
  );
  const files =
    names.length > NATIVE_TOOL_LABEL_FILES
      ? `${names.slice(0, NATIVE_TOOL_LABEL_FILES).join(', ')} and ${names.length - NATIVE_TOOL_LABEL_FILES} more`
      : names.join(', ');
  const verb = tool.kind && NATIVE_TOOL_VERBS[tool.kind];
  const subject = tool.kind === 'command' ? tool.command?.trim().split(/\r?\n/)[0] : files;
  if (!verb || !subject) return tool.name;
  return nativeClip(`${verb} ${subject}`, NATIVE_TOOL_LABEL_CHARS);
}

/**
 * A command card's text: "$ npm test", then the last 10 lines it printed, with "… 12 earlier lines"
 * above them; its raw input and output stay one tap away. Undefined for any other tool, whose card
 * shows its raw input and output.
 */
export function nativeCommandText(tool: NativeSessionTool | undefined): string | undefined {
  if (tool?.kind !== 'command' || !tool.command) return undefined;
  // One line of the command: a heredoc would push the output out of view. All of it is in Raw.
  const lines = tool.command.trim().split(/\r?\n/);
  const command = `$ ${nativeClip(lines.length > 1 ? `${lines[0]} …` : lines[0], NATIVE_COMMAND_CHARS)}`;
  if (tool.output === undefined) return command;
  const text = nativeOutputText(tool.output);
  // Output that is not text would look like no output here; its raw card shows it.
  if (text === undefined) return undefined;
  const output = terminalLinesFromText(text.replace(/[\r\n]+$/, ''));
  if (!output.join('')) return command;
  const hidden = Math.max(0, output.length - NATIVE_TOOL_OUTPUT_LINES);
  return [
    command,
    ...(hidden ? [`… ${hidden} earlier ${hidden === 1 ? 'line' : 'lines'}`] : []),
    ...output.slice(hidden),
  ].join('\n');
}

/**
 * Runners return output as a string, as text blocks (`{ text }` or `{ content: { text } }`), or as a
 * process result (`{ stdout, stderr }`).
 */
function nativeOutputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const { stdout, stderr } = output as Record<string, unknown>;
    const streams = [stdout, stderr].filter(
      (stream): stream is string => typeof stream === 'string',
    );
    if (!streams.length) return undefined;
    return streams
      .map((stream) => stream.replace(/[\r\n]+$/, ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!Array.isArray(output)) return undefined;
  const texts = output.flatMap((block: unknown) => {
    const value = block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
    const content =
      value.content && typeof value.content === 'object'
        ? (value.content as Record<string, unknown>)
        : {};
    const text = typeof value.text === 'string' ? value.text : content.text;
    return typeof text === 'string' ? [text] : [];
  });
  return texts.length ? texts.join('\n') : undefined;
}

export type NativeTimelineRow =
  /** `fold`: the summary row that hides this tool while folded. */
  | { kind: 'entry'; key: number; entry: NativeTimelineEntry; fold?: number }
  /** Keyed by the entry that ended its turn; `tools` are the keys it hides. */
  | { kind: 'work'; key: number; label: string; tools: number[] };

/**
 * The timeline with a summary row for each finished turn's tool calls, "Worked for 4m 12s ·
 * 6 tools", just before the turn's end, and those tools marked with it. Nothing moves when a
 * turn finishes: the tools keep their place and their keys, and the row is added below them.
 * A turn ends at `turn.completed`, or at `session.closed` when its host stopped mid-turn.
 * Messages and statuses stay; a running turn has no summary.
 */
export function nativeTimelineRows(entries: NativeTimelineEntry[]): NativeTimelineRow[] {
  const rows: NativeTimelineRow[] = [];
  let turn: NativeTimelineEntry[] = [];
  for (const entry of entries) {
    const ends =
      entry.kind === 'status' && ['turn.completed', 'session.closed'].includes(entry.event.type);
    if (!ends) {
      turn.push(entry);
      continue;
    }
    const tools = turn.filter((item) => item.kind === 'tool');
    for (const item of turn)
      rows.push({
        kind: 'entry',
        key: item.key,
        entry: item,
        ...(tools.length && item.kind === 'tool' ? { fold: entry.key } : {}),
      });
    if (tools.length) {
      const prompt =
        turn.find(
          (item) =>
            item.kind === 'user' &&
            entry.event.commandId !== undefined &&
            item.event.commandId === entry.event.commandId,
        ) ?? turn.find((item) => item.kind === 'user');
      // Without its prompt in the kept history, the turn's first kept entry is the best start.
      const opened = prompt ?? turn[0];
      const elapsed = nativeElapsed(Date.parse(entry.event.at) - Date.parse(opened.event.at));
      const outcome =
        entry.event.type === 'session.closed' || entry.event.status === 'interrupted'
          ? 'Stopped after'
          : entry.event.status === 'failed'
            ? 'Failed after'
            : 'Worked for';
      rows.push({
        kind: 'work',
        key: entry.key,
        label: `${outcome} ${elapsed} · ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`,
        tools: tools.map((tool) => tool.key),
      });
    }
    rows.push({ kind: 'entry', key: entry.key, entry });
    turn = [];
  }
  for (const item of turn) rows.push({ kind: 'entry', key: item.key, entry: item });
  return rows;
}

/**
 * Tools shown running in a live read here. A turn the reader watched starts open when it
 * finishes, so its tools don't fold away under them. A stored snapshot is not live: a turn that
 * finished while the reader was away starts folded.
 */
export function nativeWatchTools(rows: NativeTimelineRow[], watched: Set<number>, live: boolean) {
  if (!live) return;
  for (const row of rows)
    if (row.kind === 'entry' && row.entry.kind === 'tool' && row.fold === undefined)
      watched.add(row.key);
}

export function nativeFoldWatched(
  row: Extract<NativeTimelineRow, { kind: 'work' }>,
  watched: ReadonlySet<number>,
): boolean {
  return row.tools.some((key) => watched.has(key));
}
