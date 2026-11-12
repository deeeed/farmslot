import type { Run, RunListRow } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import type { LabelledReadObservation } from '../../lib/resource-read-status';

/**
 * The reads Run Detail's status line reports. While a run.list row is on screen it is dated from
 * the run list. run.get's own saved copy isn't on screen then, so only its errors are reported:
 * its age would read as a second "Saved run" beside the row's.
 */
export function runDetailReadObservations({
  fromList,
  listObservation,
  runObservation,
  evidenceObservation,
  progressObservation,
}: {
  fromList: boolean;
  listObservation: ResourceQueryState;
  runObservation: ResourceQueryState;
  evidenceObservation: ResourceQueryState;
  progressObservation?: ResourceQueryState;
}): LabelledReadObservation[] {
  return [
    ...(fromList
      ? [
          { observation: listObservation, label: 'run' },
          { observation: { ...runObservation, data: undefined }, label: 'run' },
        ]
      : [{ observation: runObservation, label: 'run' }]),
    { observation: evidenceObservation, label: 'run evidence' },
    ...(progressObservation ? [{ observation: progressObservation, label: 'task progress' }] : []),
  ];
}

/** Run Detail's Retry: the run list too when the row on screen came from a list read that failed. */
export async function retryRunDetailReads({
  fromList,
  listObservation,
  retryList,
  retryReads,
}: {
  fromList: boolean;
  listObservation: ResourceQueryState;
  retryList: () => Promise<void>;
  retryReads: () => Promise<void>;
}): Promise<void> {
  await Promise.all([fromList && listObservation.error ? retryList() : undefined, retryReads()]);
}

/**
 * A held run.get with a newer run.list row's own fields laid over it: status, summary,
 * timestamps, the row's metrics and the other top-level facts come from the row. Steps,
 * decisions, engine state, output, agent contexts, the ticket, the review result and the review
 * subject stay the held detail's until run.get's reread lands, because a run.list row leaves
 * their detail out (step outputs, decision payloads such as `prPackage`, the output manifest,
 * the review text, the ticket description).
 */
export function heldDetailWithNewerRow(detail: Run, row: RunListRow): Run {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars -- the held detail keeps these */
    steps,
    decisions,
    engineState,
    output,
    evidenceSummary,
    agentContexts,
    ticketData,
    reviewResult,
    reviewWorkspaceSubject,
    detailTrimmed,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    metrics,
    ...rowFacts
  } = row;
  return { ...detail, ...rowFacts, metrics: { ...detail.metrics, ...metrics } };
}
