import type { RecipeFailureCause } from '@farmslot/protocol';

import type { ActionResult, TraceEntry, TraceWriter } from './types.js';

export function recordSyntheticFailure(
  traceWriter: TraceWriter,
  nodeId: string,
  error: Error,
  action = 'unknown',
  causeClass: RecipeFailureCause = 'unknown',
): void {
  const now = new Date().toISOString();
  traceWriter.record({
    nodeId,
    action,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    ok: false,
    cause_class: causeClass,
    error: error.message,
  });
}

export function traceNodeMetadata(
  node: Record<string, unknown>,
  result?: ActionResult,
): Pick<TraceEntry, 'intent' | 'proves' | 'artifacts'> {
  const metadata: Pick<TraceEntry, 'intent' | 'proves' | 'artifacts'> = {};
  if (typeof node.intent === 'string' && node.intent.trim()) metadata.intent = node.intent;
  if (Array.isArray(node.proves)) {
    metadata.proves = node.proves.filter(
      (proofTarget): proofTarget is string => typeof proofTarget === 'string',
    );
  }
  if (result?.artifacts?.length) metadata.artifacts = result.artifacts;
  return metadata;
}
