import { html, nothing } from 'lit';

import type { Run, RunnerSessionUsage } from '@farmslot/protocol';
import { runCostSummary, runCostSummaryForRun } from '@farmslot/review-dispatch';

export {
  priorRunSessions,
  reviewRoundCosts,
  runCostBreakdown,
  runCostReceipts,
} from '@farmslot/review-dispatch';

export function renderRunCost(
  input: Run | readonly RunnerSessionUsage[],
  legacyEstimate?: number | null,
  priorSessions?: ReadonlySet<string>,
  estimatePhase: 'Implementation' | 'Review' = 'Implementation',
) {
  const cost =
    'metrics' in input
      ? runCostSummaryForRun(input)
      : runCostSummary(input, legacyEstimate, priorSessions, estimatePhase);
  if (!cost) return nothing;
  return html`<section class="meta-item run-cost" aria-label="Run cost" data-testid="run-cost">
    <div class="run-cost-heading">
      <strong>${cost.subtotal}</strong>
      <span class="meta-label">${cost.coverage}</span>
      ${cost.estimate ? html`<span class="meta-label">${cost.estimate}</span>` : nothing}
    </div>
    ${cost.phases.length
      ? html`<dl class="run-cost-phases">
          ${cost.phases.map(
            ({ phase, label, detail }) =>
              html`<div data-phase=${phase}>
                <dt class="meta-label">${phase}</dt>
                <dd>${label}${detail ? html`<small> · ${detail}</small>` : nothing}</dd>
              </div>`,
          )}
        </dl>`
      : nothing}
  </section>`;
}
