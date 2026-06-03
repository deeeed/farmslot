import { html, nothing } from 'lit';

import type { EvalExperimentCreateResult } from '@farmslot/protocol';

export interface EvalCockpitShellRenderOptions {
  evalResult: EvalExperimentCreateResult | null;
  selectedCaseCount: number;
  enabledCandidateCount: number;
  trialCount: number;
  datasetId: string;
  busy: string;
  error: string;
  renderProductModelGuide: () => unknown;
  renderCaseBrowser: () => unknown;
  renderCandidateMatrix: () => unknown;
  renderOperationalSummary: () => unknown;
  renderPackageMatrix: () => unknown;
}

export function renderEvalCockpitShell(options: EvalCockpitShellRenderOptions) {
  return html`
    <div class="eval-cockpit">
      <div class="eval-hero">
        <div>
          <div class="eyebrow">Eval cockpit</div>
          <h2>Many cases, artifact-only strategy trials</h2>
          <p>
            Select prior cases into a local basket, apply candidate strategies, then queue
            artifact-only trials through the shared dispatcher.
          </p>
        </div>
      </div>
      ${options.busy ? html`<div class="eval-status">${options.busy}…</div>` : nothing}
      ${options.error ? html`<div class="eval-error">${options.error}</div>` : nothing}
      <div class="eval-status">
        Replay plan ${options.selectedCaseCount}
        Reference${options.selectedCaseCount === 1 ? '' : 's'} · ${options.enabledCandidateCount}
        enabled Candidate${options.enabledCandidateCount === 1 ? '' : 's'} · ${options.trialCount}
        planned trial${options.trialCount === 1 ? '' : 's'} · dataset ${options.datasetId}
      </div>
      <div class="eval-scroll-help">
        Scroll this cockpit vertically. Case lists and wide tables have their own scrollbars for
        long content.
      </div>
      ${options.evalResult
        ? html`<div class="eval-status">
            Latest experiment ${options.evalResult.experimentId} ·
            ${options.evalResult.experimentKey.slice(0, 12)} ·
            <a href=${`#family/${options.evalResult.familyId}`}>open family</a>
          </div>`
        : nothing}
      ${options.renderProductModelGuide()} ${options.renderCaseBrowser()}
      ${options.renderCandidateMatrix()} ${options.renderOperationalSummary()}
      ${options.renderPackageMatrix()}
    </div>
  `;
}
