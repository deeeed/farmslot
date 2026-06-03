import { JsonTraceWriter } from '../node/writers.js';

import type { ActionResult, TraceEntry } from './types.js';

export function recordSyntheticFailure(
  traceWriter: JsonTraceWriter,
  nodeId: string,
  error: Error,
  action = 'unknown',
): void {
  const now = new Date().toISOString();
  traceWriter.record({
    nodeId,
    action,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    ok: false,
    error: error.message,
  });
}

export function traceNodeMetadata(
  node: Record<string, unknown>,
  result?: ActionResult,
): Pick<TraceEntry, 'intent' | 'phase' | 'record' | 'artifacts'> {
  const metadata: Pick<TraceEntry, 'intent' | 'phase' | 'record' | 'artifacts'> = {};
  if (typeof node.intent === 'string' && node.intent.trim()) metadata.intent = node.intent;
  if (typeof node.phase === 'string') metadata.phase = node.phase;
  if (node.record !== undefined) metadata.record = node.record;
  if (result?.artifacts?.length) metadata.artifacts = result.artifacts;
  return metadata;
}
