import type { FamilyObservabilityRunSummary, GateSummary } from '@farmslot/protocol';

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
