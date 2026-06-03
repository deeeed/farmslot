import { html, nothing } from 'lit';

import type { FamilyObservabilityRunSummary } from '@farmslot/protocol';

import '../workspace/recipe-output-panel.js';

import { spacing } from '../../styles/theme-tokens.js';
import type { RecipeCockpitView } from '../recipe/recipe-quality-cockpit.js';
import { renderRecipeQualityCockpit } from '../recipe/recipe-quality-cockpit.js';
import { createFamilyObservabilityRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';

interface FamilyRecipeRerunCheck {
  ok: boolean;
  reason?: string;
  slotId?: string;
}

interface FamilyRecipePanelRenderOptions {
  selectedRun: FamilyObservabilityRunSummary | null;
  rerunCheck: FamilyRecipeRerunCheck;
  recipeView: RecipeCockpitView;
  showRerunOutput: boolean;
  onRecipeViewChange: (view: RecipeCockpitView) => void;
  onRerunOnWarmSlot: (run: FamilyObservabilityRunSummary) => void;
  onOpenSlotHistoryAt: (run: FamilyObservabilityRunSummary) => void;
  onRerunRunningChange: (event: CustomEvent<boolean>) => void;
  renderGradingPanel: (run: FamilyObservabilityRunSummary) => unknown;
  renderImprovementTrigger: (run: FamilyObservabilityRunSummary) => unknown;
}

export function renderFamilyRecipePanel(options: FamilyRecipePanelRenderOptions) {
  const selectedRun = options.selectedRun;
  const recipeHost = selectedRun
    ? createFamilyObservabilityRecipeHostEntry({
        runId: selectedRun.runId,
        slotId: options.rerunCheck.slotId ?? null,
        branch: selectedRun.branch,
        recipeJson: selectedRun.recipeJson,
        recipeQualityArtifact: selectedRun.recipeQualityArtifact,
        workerLearnings: selectedRun.workerLearnings,
        canRerun: options.rerunCheck.ok,
      })
    : null;

  if (!selectedRun || !recipeHost) {
    return html`<div class="muted">No recipe artifact available for the selected run.</div>`;
  }

  return html`
    ${renderRecipeQualityCockpit({
      recipeJson: recipeHost.recipeJson,
      recipeView: options.recipeView,
      onRecipeViewChange: (view) => options.onRecipeViewChange(view),
      showRecipe: true,
      emptyRecipeMessage: 'No recipe artifact available for the selected run.',
      actionContent: html`
        <button
          class="action-btn"
          ?disabled=${!options.rerunCheck.ok}
          title=${options.rerunCheck.ok
            ? `Rerun on warm slot ${options.rerunCheck.slotId}`
            : (options.rerunCheck.reason ?? '')}
          @click=${() => options.onRerunOnWarmSlot(selectedRun)}
        >
          Rerun on warm slot${options.rerunCheck.ok ? html` · ${options.rerunCheck.slotId}` : ''}
        </button>
        ${selectedRun.slotId
          ? html`
              <button
                class="action-btn"
                title=${`Open slot ${selectedRun.slotId} with history modal pre-selecting this run`}
                @click=${() => options.onOpenSlotHistoryAt(selectedRun)}
              >
                Open in slot history
              </button>
            `
          : nothing}
      `,
      afterActionContent: html`
        ${!options.rerunCheck.ok && options.rerunCheck.reason
          ? html`<div class="muted recipe-hint" style="margin-top:${spacing.sm};">
              ${options.rerunCheck.reason}
            </div>`
          : nothing}
        ${selectedRun.recipeProvenance?.status === 'resolved'
          ? html`<div class="muted recipe-hint" style="margin-top:${spacing.sm};">
              Recipe recovered from historical run
              ${selectedRun.recipeProvenance.sourceRunId?.slice(0, 8) ?? 'unknown'}${selectedRun
                .recipeProvenance.sourceSlotId
                ? ` on ${selectedRun.recipeProvenance.sourceSlotId}`
                : ''}.
            </div>`
          : nothing}
        ${options.renderGradingPanel(selectedRun)} ${options.renderImprovementTrigger(selectedRun)}
      `,
      outputContent:
        options.showRerunOutput && recipeHost.outputTarget
          ? html`<recipe-output-panel
              .runId=${recipeHost.outputTarget.runId}
              .slotId=${recipeHost.outputTarget.slotId}
              @running-change=${(event: CustomEvent<boolean>) =>
                options.onRerunRunningChange(event)}
            ></recipe-output-panel>`
          : undefined,
    })}
  `;
}
