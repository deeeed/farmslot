import type { FamilyObservabilityRunSummary, GateSummary, RunDecision } from '@farmslot/protocol';

import { decisionPayloadKind } from '../shared/decision-payload-model.js';

/** Pull the run's gate-summary (worker/self-review/sub-agent per-model breakdown) off its decisions. */
export function runGateSummary(run: FamilyObservabilityRunSummary): GateSummary | undefined {
  return run.decisions
    ?.map((decision) =>
      decision.payload?.kind === 'ready' || decision.payload?.kind === 'retrospective'
        ? decision.payload.gateSummary
        : undefined,
    )
    .find((summary): summary is GateSummary => Boolean(summary));
}

/** Pending publish-gate first, otherwise the newest resolved ready decision. */
export function familyReadyGateDecision(
  run: { decisions?: readonly RunDecision[] } | null | undefined,
): RunDecision | null {
  const readyDecisions =
    run?.decisions?.filter((decision) => decisionPayloadKind(decision.payload) === 'ready') ?? [];
  const pending = readyDecisions.find((decision) => !decision.resolvedAt);
  const resolved = readyDecisions
    .filter((decision) => decision.resolvedAt)
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0];
  return pending ?? resolved ?? null;
}

export function familyPublishGateReopenLabel(input: {
  decision: RunDecision;
  gateOpen: boolean;
}): string {
  if (input.gateOpen) return 'Close publish gate';
  return input.decision.resolvedAt ? 'Reopen publish gate' : 'Open publish gate';
}

export function familyPublishGateMaximizeLabel(maximized: boolean): string {
  return maximized ? 'Restore' : 'Maximize';
}
