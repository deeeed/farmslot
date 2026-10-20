import type { RequestFrame, ResponseFrame } from '@farmslot/protocol';

interface NativeStartupTiming {
  startTime?: number;
}

type NativePerformance = typeof performance & { rnStartupTiming?: NativeStartupTiming };
type BaselineTimingSource = 'native-startup' | 'socket-close-event' | 'phase-start' | 'unavailable';

export interface OfflineBaselineSample {
  phase: 'cold' | 'reconnect' | 'diff';
  method: string;
  elapsedMs: number;
  requestMs: number;
  receivedBytes: number;
  responseBytes: number;
  runCount?: number;
  diffCharacters?: number;
  timingSource: BaselineTimingSource;
}

/** Dev-only byte counter for the offline-store baseline; it retains no payload or auth values. */
export function createOfflineClientStoreBaseline(interrupt: () => void) {
  const pending = new Map<string, { method: string; startedAt: number }>();
  const samples: OfflineBaselineSample[] = [];
  let phase: OfflineBaselineSample['phase'] = 'cold';
  const nativeStart = (performance as NativePerformance).rnStartupTiming?.startTime;
  let timingSource: BaselineTimingSource = Number.isFinite(nativeStart)
    ? 'native-startup'
    : 'unavailable';
  let startedAt = nativeStart ?? 0;
  let receivedBytes = 0;
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
      pending.clear();
      samples.length = 0;
    },
    sent(frame: RequestFrame) {
      const params = frame.params as { runId?: string; slotId?: string } | undefined;
      const relevant =
        phase === 'diff'
          ? frame.method === 'git.diff' &&
            target !== undefined &&
            Object.entries(target).every(([key, value]) =>
              params ? Reflect.get(params, key) === value : false,
            )
          : frame.method === 'run.list';
      if (relevant) pending.set(frame.id, { method: frame.method, startedAt: performance.now() });
    },
    received(raw: string, frame: ResponseFrame | { type: 'event' }) {
      const bytes = encoder.encode(raw).byteLength;
      receivedBytes += bytes;
      if (frame.type !== 'res') return;
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
  };
}
