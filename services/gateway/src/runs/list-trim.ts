// runs/list-trim.ts — keep run.list small enough to bootstrap the UI.
//
// A run list of a few hundred runs carried ~85 MB, 59 MB of it decision
// payloads (input snapshots, PR packages, review markdown, artifact manifests)
// that only the page for that one run ever renders. The UI bootstrap request
// timed out on it, which paused every run-page action (gate approvals, step
// replays) behind "Run refresh failed". The list now drops any decision payload
// value above RUN_LIST_PAYLOAD_VALUE_LIMIT bytes and names the dropped keys in
// `payloadTrimmed`; run.get, run.forSlot and run events stay complete.

import type { Run, RunDecision, RunDecisionPayload } from '@farmslot/protocol';

/** JSON size in UTF-8 bytes above which a single decision payload value is left out of run.list. */
export const RUN_LIST_PAYLOAD_VALUE_LIMIT = 2048;

export function trimDecisionForList(decision: RunDecision): RunDecision {
  if (!decision.payload) return decision;
  // A list row's payload is the same shape with some keys left out; Partial is
  // the honest type while keys are removed from the copy.
  const kept = { ...decision.payload } as Partial<RunDecisionPayload>;
  const trimmed: string[] = [];
  for (const key of Object.keys(kept) as Array<keyof RunDecisionPayload>) {
    const value = kept[key];
    if (
      value !== undefined &&
      Buffer.byteLength(JSON.stringify(value), 'utf8') > RUN_LIST_PAYLOAD_VALUE_LIMIT
    ) {
      delete kept[key];
      trimmed.push(key);
    }
  }
  if (trimmed.length === 0) return decision;
  return { ...decision, payload: kept as RunDecisionPayload, payloadTrimmed: trimmed };
}

/** A copy of `run` for run.list; the store's own object is never mutated. */
export function trimRunForList(run: Run): Run {
  if (!run.decisions?.length) return run;
  let changed = false;
  const decisions = run.decisions.map((decision) => {
    const next = trimDecisionForList(decision);
    if (next !== decision) changed = true;
    return next;
  });
  return changed ? { ...run, decisions } : run;
}
