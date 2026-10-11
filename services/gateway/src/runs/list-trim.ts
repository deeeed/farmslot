// runs/list-trim.ts — keep run.list small enough to bootstrap the UI.
//
// A run list of a few hundred runs carried ~85 MB, 59 MB of it decision
// payloads (input snapshots, PR packages, review markdown, artifact manifests)
// that only the page for that one run ever renders. The UI bootstrap request
// timed out on it, which paused every run-page action (gate approvals, step
// replays) behind "Run refresh failed". The list now drops any decision payload
// value above RUN_LIST_PAYLOAD_VALUE_LIMIT bytes and removes context.checkSnapshot, naming omitted values in
// `payloadTrimmed`; run.get, run.forSlot and run events stay complete.

import {
  CI_SNAPSHOT_TRIM_KEY,
  type Run,
  type RunDecision,
  type RunDecisionPayload,
} from '@farmslot/protocol';

/** JSON size in UTF-8 bytes above which a single decision payload value is left out of run.list. */
export const RUN_LIST_PAYLOAD_VALUE_LIMIT = 2048;

/** UTF-8 size of `text`; what the wire carries, not the UTF-16 length. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function trimDecisionForList(decision: RunDecision): RunDecision {
  const trimmed: string[] = [];
  let context = decision.context;
  if (context?.checkSnapshot !== undefined) {
    context = { ...context };
    delete context.checkSnapshot;
    trimmed.push(CI_SNAPSHOT_TRIM_KEY);
  }
  if (!decision.payload)
    return trimmed.length ? { ...decision, context, payloadTrimmed: trimmed } : decision;
  // A list row's payload is the same shape with some keys left out; Partial is
  // the honest type while keys are removed from the copy.
  const kept = { ...decision.payload } as Partial<RunDecisionPayload>;
  for (const key of Object.keys(kept) as Array<keyof RunDecisionPayload>) {
    const value = kept[key];
    if (
      value !== undefined &&
      utf8ByteLength(JSON.stringify(value)) > RUN_LIST_PAYLOAD_VALUE_LIMIT
    ) {
      delete kept[key];
      trimmed.push(key);
    }
  }
  if (trimmed.length === 0) return decision;
  return { ...decision, context, payload: kept as RunDecisionPayload, payloadTrimmed: trimmed };
}

/** A copy of `run` for run.list; the store's own object is never mutated. */
export function trimRunForList(run: Run): Run {
  const output = run.output?.artifactManifest.length
    ? { ...run.output, artifactManifest: [], artifactManifestOmitted: true }
    : run.output;
  let changed = output !== run.output;
  const decisions = (run.decisions ?? []).map((decision) => {
    const next = trimDecisionForList(decision);
    if (next !== decision) changed = true;
    return next;
  });
  return changed ? { ...run, output, decisions } : run;
}
