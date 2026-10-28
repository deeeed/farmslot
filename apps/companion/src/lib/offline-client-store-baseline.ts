import type { RequestFrame, ResponseFrame } from '@farmslot/protocol';

interface NativeStartupTiming {
  startTime?: number;
}

type NativePerformance = typeof performance & { rnStartupTiming?: NativeStartupTiming };
type BaselineTimingSource = 'native-startup' | 'socket-close-event' | 'phase-start' | 'unavailable';

/** A version-list read, a catch-up page of rows by id, or an ordinary run list read. */
export type RunListFrameKind = 'versions' | 'ids' | 'list';

/** One run.list reply, for receipts. It keeps sizes, counts and run ids, never row data. */
export interface RunListFrame {
  kind: RunListFrameKind;
  /** How many ids an `ids` page asked for, and which. */
  ids?: number;
  requestedIds?: string[];
  ok: boolean;
  requestMs: number;
  responseBytes: number;
  /** Rows the reply carried. */
  rows?: number;
  /** Versions a version reply listed. */
  versions?: number;
  /** The socket it travelled on: 0 at launch, then one more for each closed socket. */
  connection: number;
  /** Wall-clock time of the reply, so a receipt can start at a known moment. */
  at: number;
}

const RUN_LIST_FRAMES = 200;
/** A request with no reply after this has failed or timed out, and no longer counts as pending. */
const PENDING_RUN_LIST_MS = 60_000;

function runListFrameKind(params: unknown): {
  kind: RunListFrameKind;
  requestedIds?: string[];
} {
  const ids = params && typeof params === 'object' ? Reflect.get(params, 'ids') : undefined;
  if (Array.isArray(ids)) return { kind: 'ids', requestedIds: ids.map(String) };
  return params && typeof params === 'object' && Reflect.get(params, 'versions') === true
    ? { kind: 'versions' }
    : { kind: 'list' };
}

export interface OfflineBaselineSample {
  phase: 'cold' | 'reconnect' | 'diff';
  method: string;
  runListKind?: RunListFrameKind;
  elapsedMs: number;
  requestMs: number;
  receivedBytes: number;
  responseBytes: number;
  runCount?: number;
  /** Run list replies up to the merged run list, when it ends a version-list read. */
  runListReplies?: number;
  diffCharacters?: number;
  timingSource: BaselineTimingSource;
}

/** Dev-only byte counter for the offline-store baseline; it retains no payload or auth values. */
export function createOfflineClientStoreBaseline(interrupt: () => void) {
  const pending = new Map<
    string,
    { method: string; startedAt: number; runListKind?: RunListFrameKind }
  >();
  const runLists = new Map<
    string,
    { startedAt: number; kind: RunListFrameKind; requestedIds?: string[] }
  >();
  const frames: RunListFrame[] = [];
  let connection = 0;
  let framesSent = 0;
  const samples: OfflineBaselineSample[] = [];
  /** run.list reads still awaiting a reply on this socket. */
  const pendingRunLists = () => {
    const now = performance.now();
    return [...runLists.values()].filter((entry) => now - entry.startedAt < PENDING_RUN_LIST_MS)
      .length;
  };
  let phase: OfflineBaselineSample['phase'] = 'cold';
  const nativeStart = (performance as NativePerformance).rnStartupTiming?.startTime;
  let timingSource: BaselineTimingSource = Number.isFinite(nativeStart)
    ? 'native-startup'
    : 'unavailable';
  let startedAt = nativeStart ?? 0;
  let receivedBytes = 0;
  // Wall clock, like a query's observedAt.
  let phaseBegan = Date.now();
  let target: { runId?: string; slotId?: string } | undefined;
  const encoder = new TextEncoder();
  return {
    interrupt() {
      samples.length = 0;
      pending.clear();
      interrupt();
    },
    timingSource: () => timingSource,
    begin(next: OfflineBaselineSample['phase'], match?: typeof target) {
      phase = next;
      timingSource =
        next === 'cold'
          ? Number.isFinite(nativeStart)
            ? 'native-startup'
            : 'unavailable'
          : next === 'reconnect'
            ? 'socket-close-event'
            : 'phase-start';
      target = match;
      startedAt = next === 'cold' ? (nativeStart ?? 0) : performance.now();
      receivedBytes = 0;
      phaseBegan = Date.now();
      pending.clear();
      samples.length = 0;
      // A reconnect begins when the socket closes; its unanswered reads died with it.
      if (next === 'reconnect') {
        connection++;
        runLists.clear();
      }
    },
    sent(frame: RequestFrame) {
      framesSent++;
      const params = frame.params as { runId?: string; slotId?: string } | undefined;
      const runList = frame.method === 'run.list' ? runListFrameKind(frame.params) : undefined;
      if (runList) runLists.set(frame.id, { startedAt: performance.now(), ...runList });
      const relevant =
        phase === 'diff'
          ? frame.method === 'git.diff' &&
            target !== undefined &&
            Object.entries(target).every(([key, value]) =>
              params ? Reflect.get(params, key) === value : false,
            )
          : frame.method === 'run.list';
      if (relevant)
        pending.set(frame.id, {
          method: frame.method,
          startedAt: performance.now(),
          ...(runList ? { runListKind: runList.kind } : {}),
        });
    },
    received(raw: string, frame: ResponseFrame | { type: 'event' }) {
      const bytes = encoder.encode(raw).byteLength;
      receivedBytes += bytes;
      if (frame.type !== 'res') return;
      const listed = runLists.get(frame.id);
      if (listed) {
        runLists.delete(frame.id);
        const payload = frame.ok
          ? (frame.payload as { runs?: unknown[]; versions?: unknown[] } | undefined)
          : undefined;
        frames.push({
          kind: listed.kind,
          ...(listed.requestedIds
            ? { ids: listed.requestedIds.length, requestedIds: listed.requestedIds }
            : {}),
          ok: frame.ok,
          requestMs: Math.round(performance.now() - listed.startedAt),
          responseBytes: bytes,
          ...(Array.isArray(payload?.runs) ? { rows: payload.runs.length } : {}),
          ...(Array.isArray(payload?.versions) ? { versions: payload.versions.length } : {}),
          connection,
          at: Date.now(),
        });
        if (frames.length > RUN_LIST_FRAMES) frames.shift();
      }
      const request = pending.get(frame.id);
      if (!request) return;
      pending.delete(frame.id);
      if (!frame.ok) return;
      if (phase === 'cold' && timingSource !== 'native-startup') return;
      const diff = (frame.payload as { diff?: string } | undefined)?.diff;
      if (phase === 'diff' && (typeof diff !== 'string' || !diff.length)) return;
      const now = performance.now();
      const rows = (frame.payload as { runs?: unknown[] } | undefined)?.runs;
      samples.push({
        phase,
        timingSource,
        method: request.method,
        ...(request.runListKind ? { runListKind: request.runListKind } : {}),
        elapsedMs: Math.round(now - startedAt),
        requestMs: Math.round(now - request.startedAt),
        receivedBytes,
        responseBytes: bytes,
        ...(rows ? { runCount: rows.length } : {}),
        ...(phase === 'diff' ? { diffCharacters: diff?.length } : {}),
      });
      if (samples.length > 50) samples.shift();
    },
    snapshot: () => samples.map((sample) => ({ ...sample })),
    runListFrames: () =>
      frames.map((entry) => ({
        ...entry,
        ...(entry.requestedIds ? { requestedIds: [...entry.requestedIds] } : {}),
      })),
    /** run.list reads still awaiting a reply on this socket. */
    pendingRunLists,
    /**
     * Decision 8: a run list read ends at the merged run list, after a version-list read's last
     * catch-up page, not at its small version reply. Undefined until no run.list read is pending
     * and the run list was read since the phase began.
     */
    merged(runs: { status: string; observedAt?: number }): OfflineBaselineSample | undefined {
      const read = samples.filter(
        (sample) => sample.phase === phase && sample.method === 'run.list',
      );
      const last = read.at(-1);
      if (
        phase === 'diff' ||
        !last ||
        pendingRunLists() > 0 ||
        runs.status !== 'ready' ||
        (runs.observedAt ?? 0) < phaseBegan
      )
        return undefined;
      return { ...last, runListReplies: read.length };
    },
    connection: () => connection,
    /** Request frames sent since launch or the last reset; a cold offline start sends none. */
    framesSent: () => framesSent,
    resetFramesSent() {
      framesSent = 0;
    },
  };
}
