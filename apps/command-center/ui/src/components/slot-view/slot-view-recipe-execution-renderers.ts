import { html, nothing } from 'lit';

import type { ArtifactRef } from '@farmslot/protocol';

import { spacing } from '../../styles/theme-tokens.js';
import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import type { RecipeCompleteDetail, RecipeOutputPanel } from '../workspace/recipe-output-panel.js';

import { isVisualRecipeArtifact } from './slot-view-recipe-helpers.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';

export function renderRecipeExecutionOverlay(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
) {
  return recipeHost
    ? html`
        <media-lightbox
          .items=${view._recipeLightboxItems(recipeHost)}
          .pairs=${view._recipeLightboxPairs(recipeHost)}
          .open=${view._recipeLightboxOpen}
          .selectedIndex=${view._recipeLightboxIndex}
          .mode=${view._recipeLightboxMode}
          .pairIndex=${view._recipeLightboxPairIndex}
          .scopeLabel=${view._recipeLightboxScopeLabel}
          .totalItems=${view
            ._effectiveRecipeEvidenceArtifacts(recipeHost)
            .filter(
              (artifact: ArtifactRef) =>
                isVisualRecipeArtifact(artifact) || /\.(md|markdown)$/i.test(artifact.path),
            ).length}
          @lightbox-close=${() => {
            view._recipeLightboxOpen = false;
            view._syncUrlState();
          }}
          @lightbox-navigate=${(e: CustomEvent) => {
            view._recipeLightboxIndex = e.detail.index;
            const items = view._recipeLightboxItems(recipeHost);
            const target = items[e.detail.index];
            if (target) {
              view._selectedRecipeArtifactPath = target.path;
              void view._loadSelectedRecipeArtifactPreview(recipeHost);
            }
            view._syncUrlState();
          }}
          @lightbox-mode-change=${(e: CustomEvent) => {
            view._recipeLightboxMode = e.detail.mode;
            view._syncUrlState();
          }}
          @lightbox-pair-navigate=${(e: CustomEvent) => {
            view._recipeLightboxPairIndex = e.detail.index;
            view._syncUrlState();
          }}
          @lightbox-clear-scope=${(e: CustomEvent<{ path?: string | null }>) => {
            view._clearRecipeLightboxScope(recipeHost, e.detail.path);
            view._syncUrlState();
          }}
        ></media-lightbox>
        ${view._recipeExecutionOpen
          ? html`
              <div
                class="sv-recovery-overlay"
                @click=${() => {
                  if (
                    !view.renderRoot.querySelector<RecipeOutputPanel>('#sv-recipe-overlay-runner')
                      ?.running
                  )
                    view._recipeExecutionOpen = false;
                }}
              >
                <div
                  class="sv-recovery-card"
                  style="width:min(820px, calc(100vw - 48px)); max-height:80vh; overflow:auto;"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  <div
                    style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm}; margin-bottom:${spacing.sm};"
                  >
                    <div>
                      <div class="sv-recovery-eyebrow">Recipe execution</div>
                      <div class="sv-recovery-title">${view._recipeExecutionLabel}</div>
                      ${view._recipeExecutionArtifactPath
                        ? html`<div class="sv-recovery-copy">
                            ${view._recipeExecutionArtifactPath}
                          </div>`
                        : nothing}
                    </div>
                    <button
                      class="sv-task-panel-close"
                      @click=${() => {
                        if (
                          !view.renderRoot.querySelector<RecipeOutputPanel>(
                            '#sv-recipe-overlay-runner',
                          )?.running
                        )
                          view._recipeExecutionOpen = false;
                      }}
                    >
                      &times;
                    </button>
                  </div>
                  <recipe-output-panel
                    id="sv-recipe-overlay-runner"
                    runId=${recipeHost.runId}
                    slotId=${view.slotId}
                    recipeArtifactPath=${view._recipeExecutionArtifactPath}
                    recipeRunId=${view._recipeExecutionRecipeRunId}
                    .playbackSlowMs=${view._recipeRunnerUiOptions.playbackSlowMs}
                    .recordVideo=${view._recipeRunnerUiOptions.recordVideo}
                    .showArtifactAction=${view._recipeRunnerUiOptions.showArtifactAction}
                    @running-change=${(event: CustomEvent<boolean>) => {
                      if (!event.detail) {
                        void view._refreshLinkedRun(view._linkedRun?.status ?? null);
                      }
                    }}
                    @recipe-complete=${(event: CustomEvent<RecipeCompleteDetail>) => {
                      view._handleRecipeExecutionComplete(event.detail);
                    }}
                    @recipe-artifacts-request=${(event: CustomEvent<RecipeCompleteDetail>) => {
                      view._handleRecipeExecutionComplete(event.detail);
                    }}
                  ></recipe-output-panel>
                </div>
              </div>
            `
          : nothing}
      `
    : nothing;
}
