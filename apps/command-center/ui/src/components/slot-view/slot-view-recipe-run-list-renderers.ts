import { html, nothing } from 'lit';

import type { RecipeRunArtifactGroup } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import { renderCollapsibleSectionHeader } from '../shared/collapsible-section-header.js';

import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';
import {
  slotViewRecipeRunKindLabel,
  slotViewRecipeRunSourceDetail,
  slotViewRecipeRunStatusColor,
  slotViewRecipeRunStatusLabel,
} from './slot-view-recipe-view-model.js';

export function renderRecipeRunsList(view: SlotViewRecipePresenter) {
  return view._recipeRuns.length
    ? html`
        <div
          style="display:flex; flex-direction:column; gap:4px; margin-bottom:${spacing.sm}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgCard};"
        >
          ${renderCollapsibleSectionHeader('Recipe runs', view._recipeRunsCollapsed, () => {
            view._recipeRunsCollapsed = !view._recipeRunsCollapsed;
          })}
          ${view._recipeRunsCollapsed
            ? nothing
            : html`<div style="display:flex; flex-direction:column; gap:6px;">
                ${view._recipeRuns.map(
                  (group: RecipeRunArtifactGroup) => html`
                    <button
                      data-testid=${`slot-recipe-run-${group.id}`}
                      data-group-kind=${group.groupKind}
                      style="text-align:left; border:1px solid ${view._selectedRecipeRunId ===
                      group.id
                        ? colors.accent
                        : colors.bgCardHover}; border-radius:${radii.md}; background:${view._selectedRecipeRunId ===
                      group.id
                        ? `${colors.accent}16`
                        : colors.bgSurface}; box-shadow:${view._selectedRecipeRunId === group.id
                        ? `inset 0 0 0 1px ${colors.accent}22`
                        : 'none'}; color:${colors.textPrimary}; padding:${spacing.sm}; cursor:pointer;"
                      @click=${() => {
                        view._selectedRecipeRunId = group.id;
                        view._selectedRecipeNodeId = '';
                        view._recipeEvidenceMode = 'all';
                        view._selectedRecipeArtifactPath = null;
                        view._selectedRecipeDependencyPath = '';
                        view._recipeEvidenceCache = null;
                        view._syncUrlState();
                        const nextHost = createSlotViewRecipeHostEntry(
                          view._linkedRun,
                          view.slotId,
                          view._selectedRecipeRun(),
                        );
                        void view._loadSelectedRecipeDependency(nextHost);
                        void view._loadSelectedRecipeEvidenceManifest(nextHost);
                        void view._loadSelectedRecipeArtifactPreview(nextHost);
                      }}
                    >
                      <div
                        style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm};"
                      >
                        <span style="font-size:${fonts.sizeXs}; font-weight:600;"
                          >${group.label}</span
                        >
                        ${view._selectedRecipeRunId === group.id
                          ? html`<span style="font-size:${fonts.sizeXs}; color:${colors.accent};"
                              >Selected</span
                            >`
                          : nothing}
                      </div>
                      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                        <span
                          style="padding:2px 6px; border-radius:${radii.sm}; background:${colors.bgCardHover}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
                          >${slotViewRecipeRunKindLabel(group)}</span
                        >
                        <span
                          style="padding:2px 6px; border-radius:${radii.sm}; background:${slotViewRecipeRunStatusColor(
                            group,
                          )}22; color:${slotViewRecipeRunStatusColor(
                            group,
                          )}; font-size:${fonts.sizeXs};"
                          >${slotViewRecipeRunStatusLabel(group)}</span
                        >
                      </div>
                      <div
                        style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                      >
                        ${group.recipeRunId ?? group.id}
                      </div>
                      <div
                        style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:4px;"
                      >
                        ${group.groupKind === 'current-artifacts'
                          ? 'Root task bundle: recipe, quality, PR metadata.'
                          : group.groupKind === 'latest-valid'
                            ? 'Promoted execution evidence used as the default run view.'
                            : 'Inspectable run attempt that is not promoted as the default view.'}
                      </div>
                      ${slotViewRecipeRunSourceDetail(group, view._linkedRun?.taskFile)
                        ? html`<div
                            style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:4px;"
                          >
                            ${slotViewRecipeRunSourceDetail(group, view._linkedRun?.taskFile)}
                          </div>`
                        : nothing}
                    </button>
                  `,
                )}
              </div>`}
        </div>
      `
    : html``;
}
