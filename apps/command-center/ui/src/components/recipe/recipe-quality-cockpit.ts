import { html, nothing, type TemplateResult } from 'lit';

import type { EvidenceQualityReport, RecipeQualityArtifact } from '@farmslot/protocol';

import '../recipe-graph/recipe-graph.js';
import '../workspace/quality-report-panel.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { renderCollapsibleSectionHeader } from '../shared/collapsible-section-header.js';

export type RecipeCockpitView = 'graph' | 'json';

export interface RecipeQualityCockpitConfig {
  recipeJson?: string | null;
  recipeView: RecipeCockpitView;
  onRecipeViewChange: (view: RecipeCockpitView) => void;
  recipeQualityArtifact?: RecipeQualityArtifact | null;
  qualityReport?: EvidenceQualityReport | null;
  qualityOverrides?: Map<string, string>;
  onQualityOverridesChange?: (overrides: Map<string, string>) => void;
  showQuality?: boolean;
  qualityCollapsed?: boolean;
  onToggleQuality?: () => void;
  showLearnings?: boolean;
  showRecipe?: boolean;
  recipeCollapsed?: boolean;
  onToggleRecipe?: () => void;
  learningsTitle?: string;
  learningsContent?: TemplateResult;
  actionContent?: TemplateResult;
  afterActionContent?: TemplateResult;
  outputContent?: TemplateResult;
  emptyRecipeMessage?: string;
  selectedNodeId?: string | null;
  onRecipeNodeSelect?: (nodeId: string | null) => void;
}

function formatRecipeJson(recipeJson: string): string {
  try {
    return JSON.stringify(JSON.parse(recipeJson), null, 2);
  } catch {
    return recipeJson;
  }
}

function renderRecipeQualityArtifactSummary(artifact: RecipeQualityArtifact): TemplateResult {
  const verdictColor =
    artifact.verdict === 'pass'
      ? colors.statusOk
      : artifact.verdict === 'warn'
        ? colors.statusWarn
        : colors.statusFail;

  return html`
    <div
      style="padding:8px 12px; border:1px solid ${colors.accent}33; border-radius:${radii.md}; margin-bottom:${spacing.md}; background:${colors.bgSurface}"
    >
      <div
        style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted}; margin-bottom:6px;"
      >
        Recipe Quality
      </div>
      <div style="font-weight:700; color:${verdictColor}; margin-bottom:6px;">
        ${artifact.compact.verdict}
      </div>
      <ul style="margin:0 0 8px 16px; padding:0; color:${colors.textSecondary};">
        ${artifact.compact.reasons.map((reason) => html`<li>${reason}</li>`)}
      </ul>
      ${artifact.compact.better_version_guidance.length
        ? html`
            <div style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:4px;">
              Better version
            </div>
            <ul style="margin:0 0 0 16px; padding:0; color:${colors.textSecondary};">
              ${artifact.compact.better_version_guidance.map((item) => html`<li>${item}</li>`)}
            </ul>
          `
        : nothing}
    </div>
  `;
}

export function renderRecipeQualityCockpit({
  recipeJson = null,
  recipeView,
  onRecipeViewChange,
  recipeQualityArtifact = null,
  qualityReport = null,
  qualityOverrides = new Map<string, string>(),
  onQualityOverridesChange,
  showQuality = Boolean(recipeQualityArtifact || qualityReport),
  qualityCollapsed = false,
  onToggleQuality,
  showLearnings = false,
  showRecipe = Boolean(recipeJson),
  recipeCollapsed = false,
  onToggleRecipe,
  learningsTitle = 'Learnings',
  learningsContent,
  actionContent,
  afterActionContent,
  outputContent,
  emptyRecipeMessage = 'No recipe artifact available.',
  selectedNodeId = null,
  onRecipeNodeSelect,
}: RecipeQualityCockpitConfig): TemplateResult {
  return html`
    ${showQuality && (recipeQualityArtifact || qualityReport)
      ? html`
          <div
            style="display:flex; flex-direction:column; gap:4px; margin-top:${spacing.sm}; margin-bottom:${spacing.sm}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgCard};"
          >
            ${renderCollapsibleSectionHeader('Recipe Quality', qualityCollapsed, onToggleQuality)}
            ${qualityCollapsed
              ? nothing
              : html`
                  ${recipeQualityArtifact
                    ? renderRecipeQualityArtifactSummary(recipeQualityArtifact)
                    : nothing}
                  <quality-report-panel
                    .report=${qualityReport}
                    .overrides=${qualityOverrides}
                    @override-change=${onQualityOverridesChange
                      ? (event: CustomEvent<Map<string, string>>) =>
                          onQualityOverridesChange(event.detail)
                      : nothing}
                  ></quality-report-panel>
                `}
          </div>
        `
      : nothing}
    ${showLearnings && learningsContent
      ? html`
          <div style="padding:8px 12px; border-top:1px solid ${colors.textMuted}22;">
            <div
              style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted}; margin-bottom:6px;"
            >
              ${learningsTitle}
            </div>
            ${learningsContent}
          </div>
        `
      : nothing}
    ${showRecipe
      ? html`
          <div
            style="display:flex; flex-direction:column; gap:4px; margin-top:${spacing.sm}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgCard};"
          >
            ${renderCollapsibleSectionHeader('Recipe', recipeCollapsed, onToggleRecipe)}
            ${recipeCollapsed
              ? nothing
              : html`
                  <div
                    style="display:flex; gap:${spacing.sm}; align-items:center; flex-wrap:wrap; margin-bottom:${spacing.sm};"
                  >
                    <button
                      style="border-radius:${radii.sm}; border:1px solid ${recipeView === 'graph'
                        ? colors.accent
                        : `${colors.textMuted}44`}; background:${recipeView === 'graph'
                        ? `${colors.accent}22`
                        : 'transparent'}; color:${recipeView === 'graph'
                        ? colors.textPrimary
                        : colors.textMuted}; padding:4px 10px; font-family:inherit; font-size:${fonts.sizeXs}; cursor:pointer;"
                      @click=${() => onRecipeViewChange('graph')}
                    >
                      Graph
                    </button>
                    <button
                      style="border-radius:${radii.sm}; border:1px solid ${recipeView === 'json'
                        ? colors.accent
                        : `${colors.textMuted}44`}; background:${recipeView === 'json'
                        ? `${colors.accent}22`
                        : 'transparent'}; color:${recipeView === 'json'
                        ? colors.textPrimary
                        : colors.textMuted}; padding:4px 10px; font-family:inherit; font-size:${fonts.sizeXs}; cursor:pointer;"
                      @click=${() => onRecipeViewChange('json')}
                    >
                      JSON
                    </button>
                    <span style="flex:1"></span>
                    ${actionContent ?? nothing}
                  </div>
                  ${recipeJson
                    ? recipeView === 'graph'
                      ? html`<recipe-graph
                          .recipe=${recipeJson}
                          .selectedId=${selectedNodeId ?? ''}
                          @recipe-node-select=${onRecipeNodeSelect
                            ? (event: CustomEvent<{ nodeId: string | null }>) =>
                                onRecipeNodeSelect(event.detail.nodeId)
                            : nothing}
                        ></recipe-graph>`
                      : html`<pre
                          style="margin:0; padding:12px; border-radius:${radii.md}; background:${colors.bgBase}; overflow:auto; color:${colors.textSecondary}; font-family:${fonts.mono}; font-size:${fonts.sizeXs};"
                        ><code>${formatRecipeJson(recipeJson)}</code></pre>`
                    : html`<div style="color:${colors.textMuted}; font-size:${fonts.sizeSm};">
                        ${emptyRecipeMessage}
                      </div>`}
                  ${afterActionContent ?? nothing} ${outputContent ?? nothing}
                `}
          </div>
        `
      : nothing}
  `;
}
