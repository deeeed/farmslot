import { isRecord, type SubStepRecord } from '@farmslot/protocol';

export interface SubStepCollector {
  emit: (event: string, payload: unknown) => void;
  finish: () => SubStepRecord[];
  snapshot: () => SubStepRecord[];
  getLastOutput: () => string;
}

export function createSubStepCollector(): SubStepCollector {
  const records: SubStepRecord[] = [];
  let current: {
    name: string;
    start: number;
    detail?: string;
    outcome?: SubStepRecord['outcome'];
  } | null = null;
  const outputLines: string[] = [];
  const MAX_OUTPUT_LINES = 30;

  return {
    emit: (event: string, payload: unknown) => {
      const p = isRecord(payload) ? payload : undefined;
      // Only the raw output channel (`script.output`) feeds the ring buffer.
      // Key on the event NAME, not payload shape, so a sibling event that
      // happens to carry a `{stream, data}` payload is never recorded as an
      // output line: one emitted line = one record.
      if (
        event === 'script.output' &&
        typeof p?.stream === 'string' &&
        typeof p?.data === 'string'
      ) {
        // Output stream event — capture lines into ring buffer
        const lines = p.data.split('\n');
        for (const line of lines) {
          if (line.length === 0) continue;
          if (outputLines.length >= MAX_OUTPUT_LINES) outputLines.shift();
          outputLines.push(line);
        }
        return;
      }
      const name = typeof p?.name === 'string' ? p.name : undefined;
      const detail = typeof p?.detail === 'string' ? p.detail : undefined;
      const outcome =
        p?.outcome === 'ok' || p?.outcome === 'skipped' || p?.outcome === 'failed'
          ? p.outcome
          : undefined;
      if (!name) return;
      if (current && current.name !== name) {
        records.push({
          name: current.name,
          outcome: current.outcome ?? 'ok',
          durationMs: Date.now() - current.start,
          ...(current.detail ? { detail: current.detail } : {}),
        });
      }
      if (!current || current.name !== name) {
        current = { name, start: Date.now(), detail, outcome };
      } else {
        if (detail) current.detail = detail;
        if (outcome) current.outcome = outcome;
      }
    },
    finish: () => {
      if (current) {
        records.push({
          name: current.name,
          outcome: current.outcome ?? 'ok',
          durationMs: Date.now() - current.start,
          ...(current.detail ? { detail: current.detail } : {}),
        });
        current = null;
      }
      return records;
    },
    snapshot: () => {
      const snap = [...records];
      if (current)
        snap.push({
          name: current.name,
          outcome: current.outcome ?? 'ok',
          durationMs: Date.now() - current.start,
          ...(current.detail ? { detail: current.detail } : {}),
        });
      return snap;
    },
    getLastOutput: () => outputLines.join('\n'),
  };
}
