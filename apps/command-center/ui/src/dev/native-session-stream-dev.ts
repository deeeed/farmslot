import {
  NATIVE_CONVERSATION_LIMITS,
  type NativeConversationCursor,
  type NativeConversationReset,
  type NativeSessionDeltaPayload,
  type NativeSessionEvent,
  type NativeSessionInfo,
} from '@farmslot/protocol';
import {
  createNativeConversationCache,
  type NativeConversationTransport,
} from '@farmslot/protocol/client-cache';
import { PerformanceRecorder } from '@farmslot/protocol/performance';

import type { NativeSessionFixture } from '../components/chat/native-session-view.js';
import type { NativeSessionApi } from '../components/chat/native-workspace.js';

/** Per-delta render cost, in milliseconds, for the streamed assistant message. */
export interface NativeStreamCost {
  rows: number;
  deltas: number;
  /** Delta dispatch until the view's DOM is updated and laid out (forced layout read). */
  layoutMs: NativeStreamStats;
  /** Delta dispatch until two animation frames ran: the client's text-render metric. */
  paintMs: NativeStreamStats;
  /** `farmslot_native_text_render_seconds` as the cache's recorder saw it. */
  recorder?: { count: number; meanMs: number };
}
interface NativeStreamStats {
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export type NativeStreamFixture = NativeSessionApi &
  NativeSessionFixture & {
    /** Streams `deltas` text deltas into the last assistant message, one per `flushMs`. */
    stream(deltas: number, measure: () => Element | null | undefined): Promise<NativeStreamCost>;
  };

const TURNS = 50;
const reply = (turn: number) =>
  [
    `## Turn ${turn}: what changed`,
    '',
    `I read \`src/module-${turn}.ts\` and the [design note](https://example.com/notes/${turn}). The **cache** keeps one entry per block, so a delta re-renders only the block it extends.`,
    '',
    '- updated the reducer',
    '- kept the cursor monotonic',
    '',
    '1. First step, with a loose list',
    '',
    '2. Second step',
    '',
    '```ts',
    `export function step${turn}(input: number): number {`,
    '  const doubled = input * 2;',
    '  return doubled + 1;',
    '}',
    '```',
    '',
    '| check | result |',
    '| --- | --- |',
    '| lint | pass |',
    `| tests | ${turn * 3} passed |`,
    '',
    '> A quoted line from the review, with `inline code`.',
  ].join('\n');

const streamedSource = Array.from({ length: 12 }, (_, index) => reply(1000 + index)).join('\n\n');

/**
 * A long native conversation (300+ rows) fed through the production conversation cache and its
 * reducer, with a transport that streams text deltas. Setup-time fixture; no gateway.
 */
export function createNativeStreamFixture(base: NativeSessionInfo): NativeStreamFixture {
  const session: NativeSessionInfo = {
    ...base,
    id: 'fixture-stream',
    state: 'running',
    hostPid: 1,
  };
  localStorage.setItem('farmslot-native:fixture:selected', session.id);
  const events: NativeSessionEvent[] = [];
  const add = (event: Omit<NativeSessionEvent, 'sessionId' | 'generation' | 'sequence' | 'at'>) => {
    const sequence = events.length + 1;
    events.push({
      sessionId: session.id,
      generation: session.generation,
      sequence,
      at: new Date(Date.UTC(2026, 8, 12, 8, 0, sequence)).toISOString(),
      ...event,
    });
  };
  for (let turn = 1; turn <= TURNS; turn++) {
    const commandId = `command-${turn}`;
    add({ type: 'command.submitted', commandId, text: `Run step ${turn} and report back.` });
    add({ type: 'text.delta', commandId, text: reply(turn) });
    add({
      type: 'plan.updated',
      commandId,
      plan: {
        kind: 'checklist',
        steps: [
          { text: 'Read the module', status: 'completed' },
          { text: 'Update the reducer', status: 'completed' },
        ],
      },
    });
    for (const name of ['read', 'test'])
      add({
        type: 'tool.completed',
        commandId,
        nativeId: `${name}-${turn}`,
        tool: { name, command: `yarn ${name} module-${turn}`, output: 'ok', status: 'completed' },
      });
    add({ type: 'text.delta', commandId, text: `Step ${turn} is done; the tests pass.` });
    add({ type: 'turn.completed', commandId, status: 'completed' });
  }
  const live = 'command-live';
  add({ type: 'command.submitted', commandId: live, text: 'Write the long summary.' });
  add({ type: 'text.delta', commandId: live, text: 'Summary:\n\n' });

  const cursor = (sequence: number): NativeConversationCursor => ({
    sessionId: session.id,
    executionNodeId: session.executionNodeId,
    hostGeneration: 'fixture-host',
    generation: session.generation,
    sequence,
  });
  const snapshot: NativeConversationReset = {
    session,
    events,
    cursor: events.length,
    hasMore: false,
    commands: [],
    pendingRequests: [],
    historyBefore: 0,
    truncated: false,
  };
  const deltaListeners = new Set<(payload: NativeSessionDeltaPayload) => void>();
  const transport: NativeConversationTransport = {
    async subscribe() {
      return {
        kind: 'reset',
        subscriptionId: 'fixture-stream',
        cursor: cursor(events.length),
        snapshot,
      };
    },
    async unsubscribe() {
      return undefined;
    },
    onDelta(listener) {
      deltaListeners.add(listener);
      return () => deltaListeners.delete(listener);
    },
  };
  const recorder = new PerformanceRecorder('command-center');
  const conversations = createNativeConversationCache(
    transport,
    {
      load: async () => undefined,
      save: async () => undefined,
      forget: async () => undefined,
    },
    () => ({
      id: 'fixture',
      connected: true,
      foreground: true,
      authMode: 'none',
      scope: { gatewayUrl: 'fixture://native-stream' },
      capabilities: {
        httpBearerAuth: false,
        voiceInstructionFormatting: false,
        conversationStreaming: 1,
      },
    }),
    { performance: recorder },
  ).api;

  const frames = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  // A message-channel task runs after pending microtasks (the Lit updates) without a timer clamp.
  const task = () =>
    new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(undefined);
    });
  const stats = (values: number[]): NativeStreamStats => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      max: round(sorted.at(-1) ?? 0),
      mean: round(values.reduce((total, value) => total + value, 0) / (values.length || 1)),
    };
  };

  return {
    async catalog() {
      return {
        runners: [
          {
            runner: session.runner,
            models: [session.model ?? ''],
            defaultModel: session.model ?? '',
            modes: ['default'],
          },
        ],
        contexts: [{ cwd: session.cwd, label: 'Streaming fixture' }],
      };
    },
    async list() {
      return { sessions: [session] };
    },
    async read() {
      throw new Error('The streaming preview reads through its conversation cache.');
    },
    async request() {
      throw new Error('The streaming preview is read-only.');
    },
    conversations,
    async stream(deltas, measure) {
      recorder.resetScope();
      const layout: number[] = [];
      const paint: number[] = [];
      const size = Math.ceil(streamedSource.length / deltas);
      for (let index = 0; index < deltas; index++) {
        const started = performance.now();
        const sequence = events.length + 1;
        events.push({
          sessionId: session.id,
          generation: session.generation,
          sequence,
          at: new Date(Date.UTC(2026, 8, 12, 9, 0, 0, index)).toISOString(),
          type: 'text.delta',
          commandId: live,
          text: streamedSource.slice(index * size, (index + 1) * size),
        });
        for (const listener of deltaListeners)
          listener({
            kind: 'delta',
            subscriptionId: 'fixture-stream',
            cursor: cursor(sequence),
            page: { events: [events[sequence - 1]], cursor: sequence },
          });
        await task();
        void measure()?.scrollHeight;
        layout.push(performance.now() - started);
        await frames();
        paint.push(performance.now() - started);
        const wait = NATIVE_CONVERSATION_LIMITS.flushMs - (performance.now() - started);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const histogram = recorder
        .snapshot()
        .histograms.find((row) => row.name === 'farmslot_native_text_render_seconds');
      return {
        rows: measure()?.querySelectorAll(':scope > article').length ?? 0,
        deltas,
        layoutMs: stats(layout),
        paintMs: stats(paint),
        ...(histogram
          ? {
              recorder: {
                count: histogram.count,
                meanMs: Math.round((histogram.sum / (histogram.count || 1)) * 100000) / 100,
              },
            }
          : {}),
      };
    },
  };
}
