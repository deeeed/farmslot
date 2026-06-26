import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ArtifactRef, RecipeRunArtifactGroup } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { artifactKind } from '../../utils/artifact-kind.js';
import { renderMarkdown } from '../../utils/markdown.js';
import { renderRecipeQualityCockpit } from '../recipe/recipe-quality-cockpit.js';
import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import {
  canSlotAcceptRecipeRerun,
  slotRecipeReplayBlockReason,
} from '../recipe/recipe-rerun-model.js';
import { renderCollapsibleSectionHeader } from '../shared/collapsible-section-header.js';
import type { RecipeCompleteDetail } from '../workspace/recipe-output-panel.js';

import { renderSlotRecipeDrawer } from './slot-recipe-drawer.js';
import {
  isSlotViewPinnedLinkedRun,
  shouldHideTerminalSlotRecipePanel,
  slotViewLoadedRunDrawerKey,
  slotViewNoRecipeReplayMessage,
  slotViewPendingReviewDecision,
  slotViewReviewDrawerKey,
} from './slot-view-model.js';
import {
  recipeArtifactPurposeLabel,
  renderGeneratedVisualArtifacts,
} from './slot-view-recipe-artifact-renderers.js';
import {
  canShowRecipeExecutionControls,
  isVisualRecipeArtifact,
  selectedRecipeRunRequestId,
} from './slot-view-recipe-helpers.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';
import { slotViewRecipeRunHelpText } from './slot-view-recipe-view-model.js';
import { requestedRunFromHash } from './slot-view-url-state.js';

export function renderRecipeFlowsList(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
) {
  const canRerunRecipeHost = canShowRecipeExecutionControls(
    Boolean(recipeHost?.capabilities.canRerun),
  );
  return view._recipeFlowArtifacts(recipeHost).length
    ? html`
        <div
          style="display:flex; flex-direction:column; gap:4px; margin-bottom:${spacing.sm}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgCard};"
        >
          ${renderCollapsibleSectionHeader('Included flows', view._recipeFlowsCollapsed, () => {
            view._recipeFlowsCollapsed = !view._recipeFlowsCollapsed;
          })}
          ${view._recipeFlowsCollapsed
            ? nothing
            : html`<div style="display:flex; flex-direction:column; gap:6px;">
                <button
                  data-testid="slot-recipe-flow-main"
                  style="text-align:left; border:1px solid ${view._selectedRecipeFlowPath === ''
                    ? colors.accent
                    : colors.bgCardHover}; border-radius:${radii.md}; background:${view._selectedRecipeFlowPath ===
                  ''
                    ? `${colors.accent}16`
                    : colors.bgSurface}; box-shadow:${view._selectedRecipeFlowPath === ''
                    ? `inset 0 0 0 1px ${colors.accent}22`
                    : 'none'}; color:${colors.textPrimary}; padding:${spacing.sm}; cursor:pointer;"
                  @click=${() => {
                    view._selectedRecipeFlowPath = '';
                    view._selectedRecipeNodeId = '';
                    view._selectedRecipeArtifactPath = null;
                    view._recipeEvidenceCache = null;
                    view._syncUrlState();
                    void view._loadSelectedRecipeFlow(recipeHost);
                    void view._loadSelectedRecipeArtifactPreview(recipeHost);
                  }}
                >
                  <div
                    style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm};"
                  >
                    <span style="font-size:${fonts.sizeXs}; font-weight:600;">Main recipe</span>
                    ${view._selectedRecipeFlowPath === ''
                      ? html`<span style="font-size:${fonts.sizeXs}; color:${colors.accent};"
                          >Selected</span
                        >`
                      : nothing}
                  </div>
                </button>
                ${view._recipeFlowArtifacts(recipeHost).map(
                  (artifact: ArtifactRef) => html`
                    <button
                      data-testid=${`slot-recipe-flow-${artifact.path.replace(/^artifacts\/recipe-flows\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
                      style="text-align:left; border:1px solid ${view._selectedRecipeFlowPath ===
                      artifact.path
                        ? colors.accent
                        : colors.bgCardHover}; border-radius:${radii.md}; background:${view._selectedRecipeFlowPath ===
                      artifact.path
                        ? `${colors.accent}16`
                        : colors.bgSurface}; box-shadow:${view._selectedRecipeFlowPath ===
                      artifact.path
                        ? `inset 0 0 0 1px ${colors.accent}22`
                        : 'none'}; color:${colors.textPrimary}; padding:${spacing.sm}; cursor:pointer;"
                      @click=${() => {
                        view._selectedRecipeFlowPath = artifact.path;
                        view._selectedRecipeNodeId = '';
                        view._selectedRecipeArtifactPath = null;
                        view._recipeEvidenceCache = null;
                        view._syncUrlState();
                        void view._loadSelectedRecipeFlow(recipeHost);
                        void view._loadSelectedRecipeArtifactPreview(recipeHost);
                      }}
                    >
                      <div
                        style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm};"
                      >
                        <span style="font-size:${fonts.sizeXs}; font-weight:600;"
                          >${artifact.path.replace(/^artifacts\/recipe-flows\//, '')}</span
                        >
                        ${view._selectedRecipeFlowPath === artifact.path
                          ? html`<span style="font-size:${fonts.sizeXs}; color:${colors.accent};"
                              >Selected</span
                            >`
                          : nothing}
                      </div>
                      <div
                        style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                      >
                        ${artifact.path}
                      </div>
                    </button>
                  `,
                )}
              </div>`}
        </div>
        ${!view._recipeFlowsCollapsed &&
        view._selectedRecipeFlowArtifact(recipeHost) &&
        canRerunRecipeHost
          ? html`
              ${view._selectedRecipeFlowLoading
                ? html`<div
                    style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:${spacing.xs};"
                  >
                    Loading selected flow…
                  </div>`
                : nothing}
              ${view._selectedRecipeFlowError
                ? html`<div
                    style="font-size:${fonts.sizeXs}; color:${colors.statusWarn}; margin-bottom:${spacing.xs};"
                  >
                    Failed to load selected flow: ${view._selectedRecipeFlowError}
                  </div>`
                : nothing}
              <div
                style="display:flex; gap:${spacing.sm}; align-items:center; margin-bottom:${spacing.sm}; flex-wrap:wrap;"
              >
                <button
                  class="sv-action-btn primary"
                  @click=${() =>
                    view._startRecipeExecution(
                      'Selected flow',
                      view._selectedRecipeFlowArtifact(recipeHost)?.path ?? '',
                    )}
                >
                  Run selected flow
                </button>
                <button
                  class="sv-action-btn"
                  @click=${() =>
                    void view._copyRecipeCommand(
                      view._selectedRecipeFlowArtifact(recipeHost)?.path ?? '',
                      true,
                    )}
                >
                  ${view._recipeCommandFeedback === 'copied' ? 'Copied' : 'Copy command'}
                </button>
                <span style="font-size:${fonts.sizeXs}; color:${colors.textMuted};"
                  >Runs the selected bundled flow directly on the warm slot.</span
                >
              </div>
            `
          : nothing}
      `
    : html``;
}

export function renderRecipeEvidenceSection(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
) {
  const {
    allArtifacts,
    effectiveArtifacts,
    hiddenDiagnosticCount,
    usedCuratedManifest,
    usedTypedManifest,
  } = view._recipeEvidenceArtifacts(recipeHost);
  if (allArtifacts.length === 0) return nothing;
  const kind = view._recipeEvidenceKindFilter;
  const filteredArtifacts =
    kind === 'all'
      ? effectiveArtifacts
      : effectiveArtifacts.filter((a: ArtifactRef) => artifactKind(a.path, a.purpose) === kind);
  const visualArtifacts = effectiveArtifacts.filter(isVisualRecipeArtifact);
  const KIND_CHIPS: { label: string; value: 'all' | 'before' | 'after' | 'setup' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Before', value: 'before' },
    { label: 'After', value: 'after' },
    { label: 'Setup', value: 'setup' },
  ];
  const chipStyle = (active: boolean) =>
    `padding:2px 10px; border-radius:999px; border:1px solid ${active ? colors.accent : `${colors.textMuted}44`}; background:${active ? `${colors.accent}22` : 'transparent'}; color:${active ? colors.accent : colors.textMuted}; font-size:${fonts.sizeXs}; font-family:inherit; cursor:pointer;`;
  return html`
    <div
      style="margin-top:${spacing.sm}; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgCard};"
    >
      ${renderCollapsibleSectionHeader(
        view._selectedRecipeNodeId && view._recipeEvidenceMode === 'node'
          ? `Evidence for ${view._selectedRecipeNodeId}`
          : usedTypedManifest
            ? 'Typed run artifacts'
            : usedCuratedManifest
              ? 'Curated PR evidence'
              : 'All evidence for selected run',
        view._recipeEvidenceCollapsed,
        () => {
          view._recipeEvidenceCollapsed = !view._recipeEvidenceCollapsed;
        },
      )}
      ${view._recipeEvidenceCollapsed
        ? nothing
        : html`
            <div
              style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm}; margin-bottom:4px;"
            >
              <div style="font-size:${fonts.sizeXs}; color:${colors.textMuted};">
                ${view._selectedRecipeNodeId && view._recipeEvidenceMode === 'node'
                  ? 'Strict node evidence'
                  : usedTypedManifest
                    ? 'Typed artifact index'
                    : usedCuratedManifest
                      ? 'Evidence manifest selection'
                      : 'Browse run evidence'}
              </div>
              <div style="display:flex; gap:4px;">
                ${view._selectedRecipeNodeId
                  ? html`
                      <button
                        data-testid="slot-recipe-evidence-mode-node"
                        class="sv-action-btn"
                        style="padding:2px 8px; font-size:${fonts.sizeXs}; ${view._recipeEvidenceMode ===
                        'node'
                          ? `border-color:${colors.accent}; color:${colors.accent};`
                          : ''}"
                        @click=${() => {
                          view._recipeEvidenceMode = 'node';
                          view._selectedRecipeArtifactPath = null;
                          view._recipeEvidenceCache = null;
                          view._syncUrlState();
                          void view._loadSelectedRecipeArtifactPreview(recipeHost);
                        }}
                      >
                        Node
                      </button>
                      <button
                        data-testid="slot-recipe-evidence-mode-all"
                        class="sv-action-btn"
                        style="padding:2px 8px; font-size:${fonts.sizeXs}; ${view._recipeEvidenceMode ===
                        'all'
                          ? `border-color:${colors.accent}; color:${colors.accent};`
                          : ''}"
                        @click=${() => {
                          view._recipeEvidenceMode = 'all';
                          view._selectedRecipeArtifactPath = null;
                          view._recipeEvidenceCache = null;
                          view._syncUrlState();
                          void view._loadSelectedRecipeArtifactPreview(recipeHost);
                        }}
                      >
                        All
                      </button>
                    `
                  : nothing}
                ${view._linkedRun?.slotId
                  ? html`
                      <button
                        data-testid="slot-recipe-refresh-mirror"
                        class="sv-action-btn"
                        style="padding:2px 8px; font-size:${fonts.sizeXs};"
                        ?disabled=${view._mirrorRefreshing}
                        title="Re-sync artifacts from slot disk → orchestrator mirror"
                        @click=${() => void view._refreshArtifactMirror()}
                      >
                        ${view._mirrorRefreshing
                          ? 'Syncing…'
                          : view._mirrorRefreshFeedback || 'Refresh mirror'}
                      </button>
                    `
                  : nothing}
              </div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:${spacing.xs};">
              ${KIND_CHIPS.map(
                (c) => html`
                  <button
                    data-testid=${`slot-recipe-evidence-kind-${c.value}`}
                    style=${chipStyle(kind === c.value)}
                    title=${c.value === 'before'
                      ? 'Baseline captures from main'
                      : c.value === 'after'
                        ? 'Captures from the fix branch'
                        : c.value === 'setup'
                          ? 'Orientation/setup shots'
                          : 'Show all evidence'}
                    @click=${() => {
                      view._recipeEvidenceKindFilter = c.value;
                    }}
                  >
                    ${c.label}
                  </button>
                `,
              )}
              <span
                style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-left:auto; align-self:center;"
                >${filteredArtifacts.length}/${effectiveArtifacts.length}</span
              >
            </div>
            ${usedCuratedManifest && hiddenDiagnosticCount > 0
              ? html`<div
                  style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:${spacing.xs}; line-height:1.5;"
                >
                  Showing curated PR evidence from <code>evidence-manifest.json</code>.
                  ${hiddenDiagnosticCount} artifact(s) not in the curated manifest are hidden from
                  this gallery.
                </div>`
              : nothing}
            ${usedTypedManifest
              ? html`<div
                  style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:${spacing.xs}; line-height:1.5;"
                >
                  Showing typed recipe-run artifacts from <code>artifact-manifest.json</code>.
                  Filename inference is still used for artifacts not listed in the typed manifest.
                </div>`
              : nothing}
            ${view._selectedRecipeEvidenceManifestDroppedVideoCount > 0
              ? html`<div
                  style="font-size:${fonts.sizeXs}; color:${colors.statusWarn}; margin-bottom:${spacing.xs}; line-height:1.5;"
                >
                  ${view._selectedRecipeEvidenceManifestDroppedVideoCount} video manifest
                  entr${view._selectedRecipeEvidenceManifestDroppedVideoCount === 1
                    ? 'y was'
                    : 'ies were'}
                  ignored because the file value was missing or not a supported video path.
                </div>`
              : nothing}
            ${renderGeneratedVisualArtifacts(view, recipeHost, visualArtifacts)}
            ${view._renderRecipeArtifactPreview(recipeHost)}
            ${view._selectedRecipeNodeId &&
            view._recipeEvidenceMode === 'node' &&
            effectiveArtifacts.length > 0
              ? html`<div
                  style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:${spacing.xs};"
                >
                  Showing strict node evidence only. Switch to <strong>All</strong> to inspect the
                  full run.
                </div>`
              : nothing}
            ${filteredArtifacts.length === 0
              ? html`<div
                  style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; padding:${spacing.sm} 0;"
                >
                  No artifacts match the <strong>${kind}</strong> filter.
                </div>`
              : nothing}
            <div
              style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:${spacing.sm};"
            >
              ${filteredArtifacts.slice(0, 12).map(
                (artifact: ArtifactRef) => html`
                  <button
                    data-testid=${`slot-recipe-artifact-${artifact.path.replace(/^artifacts\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
                    style="text-align:left; border:1px solid ${view._selectedRecipeArtifact(
                      recipeHost,
                    )?.path === artifact.path
                      ? colors.accent
                      : colors.bgCardHover}; border-radius:${radii.md}; background:${view._selectedRecipeArtifact(
                      recipeHost,
                    )?.path === artifact.path
                      ? `${colors.accent}16`
                      : colors.bgSurface}; box-shadow:${view._selectedRecipeArtifact(recipeHost)
                      ?.path === artifact.path
                      ? `inset 0 0 0 1px ${colors.accent}22`
                      : 'none'}; color:${colors.textPrimary}; padding:${spacing.sm}; cursor:pointer;"
                    @click=${() => {
                      view._selectedRecipeArtifactPath =
                        view._selectedRecipeArtifactPath === artifact.path ? null : artifact.path;
                      view._syncUrlState();
                      void view._loadSelectedRecipeArtifactPreview(recipeHost);
                    }}
                  >
                    <div
                      style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:4px;"
                    >
                      ${recipeArtifactPurposeLabel(artifact)}
                    </div>
                    ${artifact.label
                      ? html`<div
                          style="font-size:${fonts.sizeXs}; color:${colors.textPrimary}; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:4px;"
                        >
                          ${artifact.label}
                        </div>`
                      : nothing}
                    ${artifact.nodeId
                      ? html`<div
                          style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.accent}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:4px;"
                        >
                          ${artifact.nodeId}
                        </div>`
                      : nothing}
                    <div
                      style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textSecondary}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                    >
                      ${artifact.path}
                    </div>
                  </button>
                `,
              )}
            </div>
            ${filteredArtifacts.length > 12
              ? html`<div
                  style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:${spacing.xs};"
                >
                  +${filteredArtifacts.length - 12} more artifact(s)
                </div>`
              : nothing}
          `}
    </div>
  `;
}

function renderRecipeHostBody(
  view: SlotViewRecipePresenter,
  recipeHost: NonNullable<ReturnType<typeof createSlotViewRecipeHostEntry>>,
  selectedRecipeRun: RecipeRunArtifactGroup | null,
  effectiveRecipeJson: string | null,
) {
  const selectedFlowArtifactPath = view._selectedRecipeFlowArtifact(recipeHost)?.path ?? '';
  const replayLabel = selectedFlowArtifactPath ? 'Replay selected flow' : 'Replay live recipe';
  const selectedRecipeRunId = selectedRecipeRunRequestId(selectedRecipeRun) ?? '';
  const slotCanAcceptRerun = canSlotAcceptRecipeRerun(view._slot, view._linkedRun);
  const canReplayActiveRecipe = Boolean(
    view._linkedRun &&
    recipeHost.slotId &&
    effectiveRecipeJson &&
    slotCanAcceptRerun &&
    (recipeHost.capabilities.canRerun || selectedRecipeRunId),
  );
  const replayBlockReason =
    !canReplayActiveRecipe && effectiveRecipeJson
      ? slotRecipeReplayBlockReason({
          slot: view._slot,
          run: view._linkedRun,
          slotId: view.slotId,
          effectiveRecipeJson,
          canRerun: recipeHost.capabilities.canRerun,
          selectedRecipeRunId,
        })
      : null;
  return html`
    <div style="padding:8px 12px; border-top:1px solid ${colors.textMuted}22;">
      <div
        style="display:flex; gap:${spacing.sm}; align-items:center; flex-wrap:wrap; margin-bottom:${spacing.xs};"
      >
        <span
          style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted};"
        >
          ${recipeHost.provenanceLabel}
        </span>
        ${recipeHost.provenanceDetail
          ? html`
              <span
                style="font-family:${fonts.mono}; font-size:${fonts.sizeXs}; color:${colors.textSecondary};"
              >
                ${recipeHost.provenanceDetail}
              </span>
            `
          : nothing}
        ${recipeHost.provenanceSource !== 'decision'
          ? html`
              <span
                style="padding:2px 6px; border-radius:${radii.sm}; background:${colors.accent}22; color:${colors.accent}; font-size:${fonts.sizeXs};"
              >
                Live
              </span>
            `
          : nothing}
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:${spacing.sm};">
        <span
          style="padding:2px 8px; border-radius:${radii.sm}; background:${colors.bgCardHover}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
          >Run: ${selectedRecipeRun?.label ?? 'None'}</span
        >
        <span
          style="padding:2px 8px; border-radius:${radii.sm}; background:${colors.bgCardHover}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
          >Flow: ${view._selectedRecipeFlowLabel(recipeHost)}</span
        >
        <span
          style="padding:2px 8px; border-radius:${radii.sm}; background:${colors.bgCardHover}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
          >Node: ${view._selectedRecipeNodeId || 'None'}</span
        >
        <span
          style="padding:2px 8px; border-radius:${radii.sm}; background:${colors.bgCardHover}; color:${colors.textSecondary}; font-size:${fonts.sizeXs};"
          >Artifact: ${view._selectedRecipeArtifactLabel()}</span
        >
      </div>
      <div
        style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:${spacing.sm}; line-height:1.5;"
      >
        ${slotViewRecipeRunHelpText(selectedRecipeRun)}
      </div>
      ${replayBlockReason
        ? html`
            <div
              style="font-size:${fonts.sizeXs}; color:${colors.statusWarn}; margin-bottom:${spacing.sm}; line-height:1.5;"
            >
              ${replayBlockReason}
            </div>
          `
        : nothing}
      ${canReplayActiveRecipe
        ? html`
            <div style="margin-bottom:${spacing.sm};">
              <recipe-runner-controls
                id="sv-recipe-runner-controls"
                runId=${recipeHost.runId}
                slotId=${view.slotId}
                recipeArtifactPath=${selectedFlowArtifactPath}
                recipeRunId=${selectedRecipeRunId}
                runLabel=${replayLabel}
                .playbackSlowMs=${view._recipeRunnerUiOptions.playbackSlowMs}
                .recordVideo=${view._recipeRunnerUiOptions.recordVideo}
                ?showPlayback=${view._recipeRunnerUiOptions.showPlayback}
                ?showArtifactAction=${view._recipeRunnerUiOptions.showArtifactAction}
                @running-change=${(event: CustomEvent<boolean>) => {
                  if (!event.detail) void view._refreshLinkedRun(view._linkedRun?.status ?? null);
                }}
                @recipe-complete=${(event: CustomEvent<RecipeCompleteDetail>) => {
                  view._handleRecipeExecutionComplete(event.detail);
                }}
                @recipe-artifacts-request=${(event: CustomEvent<RecipeCompleteDetail>) => {
                  view._handleRecipeExecutionComplete(event.detail);
                }}
              ></recipe-runner-controls>
            </div>
          `
        : nothing}
      ${view._recipeRunsLoading
        ? html`<div
            style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-bottom:${spacing.sm};"
          >
            Loading recipe runs…
          </div>`
        : nothing}
      ${view._recipeRunsError
        ? html`<div
            style="font-size:${fonts.sizeXs}; color:${colors.statusWarn}; margin-bottom:${spacing.sm};"
          >
            Failed to load recipe runs: ${view._recipeRunsError}
          </div>`
        : nothing}
      ${view._renderRecipeRunsList()} ${view._renderRecipeFlowsList(recipeHost)}
      ${view._recipeJsonFallbackWarning(recipeHost)
        ? html`
            <div
              style="color:${colors.statusWarn}; font-size:${fonts.sizeXs}; margin-bottom:${spacing.sm};"
            >
              ${view._recipeJsonFallbackWarning(recipeHost)}
            </div>
          `
        : nothing}
      ${recipeHost.emptyRecipeMessage
        ? html`
            <div
              style="color:${colors.statusWarn}; font-size:${fonts.sizeXs}; margin-bottom:${spacing.sm};"
            >
              ${recipeHost.emptyRecipeMessage}
            </div>
          `
        : nothing}
      ${view._renderRecipeEvidenceSection(recipeHost)}
      ${renderRecipeQualityCockpit({
        recipeJson: effectiveRecipeJson,
        selectedNodeId: view._selectedRecipeNodeId || null,
        onRecipeNodeSelect: (nodeId) => {
          view._selectedRecipeNodeId = nodeId ?? '';
          view._recipeEvidenceMode = view._selectedRecipeNodeId ? 'node' : 'all';
          view._selectedRecipeArtifactPath = null;
          view._recipeEvidenceCache = null;
          view._syncUrlState();
          void view._loadSelectedRecipeArtifactPreview(recipeHost);
        },
        recipeView: view._slotRecipeView,
        onRecipeViewChange: (recipeView) => {
          view._slotRecipeView = recipeView;
        },
        recipeQualityArtifact: recipeHost.recipeQualityArtifact,
        qualityReport: recipeHost.qualityReport,
        qualityCollapsed: view._recipeQualityCollapsed,
        onToggleQuality: () => {
          view._recipeQualityCollapsed = !view._recipeQualityCollapsed;
        },
        recipeCollapsed: view._recipeDefinitionCollapsed,
        onToggleRecipe: () => {
          view._recipeDefinitionCollapsed = !view._recipeDefinitionCollapsed;
        },
        showQuality: Boolean(recipeHost.recipeQualityArtifact || recipeHost.qualityReport),
        showLearnings: Boolean(recipeHost.workerLearnings),
        showRecipe: Boolean(
          effectiveRecipeJson ||
          recipeHost.emptyRecipeMessage ||
          recipeHost.capabilities.canRerun ||
          recipeHost.capabilities.canCancel,
        ),
        emptyRecipeMessage: recipeHost.emptyRecipeMessage ?? undefined,
        learningsContent: recipeHost.workerLearnings
          ? html`
              <div style="font-size:${fonts.sizeSm};line-height:1.6;color:${colors.textSecondary}">
                ${unsafeHTML(renderMarkdown(recipeHost.workerLearnings))}
              </div>
            `
          : undefined,
        actionContent: undefined,
        afterActionContent:
          recipeHost.isPending && recipeHost.decisionKind === 'review'
            ? html`
                <div
                  style="margin-top:${spacing.sm}; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
                >
                  Review is still pending. Open the run detail for diff/comments; slot view only
                  hosts the shared recipe cockpit.
                </div>
              `
            : recipeHost.provenanceSource !== 'decision' && !recipeHost.capabilities.canRerun
              ? html`
                  <div
                    style="margin-top:${spacing.sm}; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
                  >
                    This live slot view is showing evidence from the selected recipe run.
                    Rerun/cancel from this drawer is not supported for the current run state yet.
                  </div>
                `
              : undefined,
        outputContent: undefined,
      })}
    </div>
  `;
}

export function renderSlotRecipePanel(view: SlotViewRecipePresenter) {
  const readyDecision = view._readyGateDecision();
  const selectedRecipeRun = view._selectedRecipeRun();
  const recipeHost = createSlotViewRecipeHostEntry(view._linkedRun, view.slotId, selectedRecipeRun);
  const effectiveRecipeJson = view._effectiveRecipeJson(recipeHost);
  const reviewDecision = slotViewPendingReviewDecision(view._linkedRun);
  const showRecipeLoading = Boolean(
    view._linkedRun && view._recipeRunsLoading && !recipeHost && !reviewDecision && !readyDecision,
  );
  const requestedRunId = requestedRunFromHash();
  if (!view._linkedRun) {
    if (!requestedRunId) return nothing;
    const drawerKey = slotViewLoadedRunDrawerKey(requestedRunId);
    return renderSlotRecipeDrawer({
      reviewPanelOpen: view._reviewPanelOpen,
      reviewFullWidth: view._reviewFullWidth,
      reviewPanelWidth: view._reviewPanelWidth,
      resizing: view._resizing,
      drawerLabel: 'RECIPE',
      collapsedTitle: 'Open recipe',
      recipeExecutionOverlay: nothing,
      bodyContent: html`
        <div style="padding:12px; display:flex; flex-direction:column; gap:${spacing.sm};">
          <div
            style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted};"
          >
            Recipe
          </div>
          <div style="font-size:${fonts.sizeSm}; color:${colors.textSecondary};">
            Loading run ${requestedRunId.slice(0, 8)} and recipe evidence…
          </div>
        </div>
      `,
      onResizeStart: (event) => view._onResizeStart('review', event),
      onToggleFullWidth: () => {
        view._reviewFullWidth = !view._reviewFullWidth;
        view._saveLayout();
      },
      onClose: () => {
        view._reviewFullWidth = false;
        view._reviewPanelOpen = false;
        view._dismissedReviewDrawerKey = drawerKey;
        view._saveLayout();
      },
      onOpen: () => {
        view._reviewPanelOpen = true;
        if (drawerKey === view._dismissedReviewDrawerKey) view._dismissedReviewDrawerKey = '';
        view._saveLayout();
      },
    });
  }
  // Hide the drawer entirely for runs whose worker won't ever produce a
  // recipe (terminal states with neither a recipe host nor a review).
  // Without this gate, a long-completed `done` or `cancelled` run shows a
  // misleading "No recipe artifact for this run yet" placeholder forever.
  const runStatus = view._linkedRun.status;
  const isTerminal = runStatus === 'done' || runStatus === 'failed' || runStatus === 'cancelled';
  const pinnedLinkedRun = isSlotViewPinnedLinkedRun(view._linkedRun.id, requestedRunFromHash());
  if (
    isTerminal &&
    shouldHideTerminalSlotRecipePanel({
      recipeHost,
      reviewDecision,
      readyDecision,
      showRecipeLoading,
      recipeRunsCount: view._recipeRuns.length,
      recipeRunsError: view._recipeRunsError,
      pinnedLinkedRun,
    })
  )
    return nothing;

  const hasPrimaryWorkspace = Boolean(readyDecision || reviewDecision);
  const canSwitchToRecipe = Boolean(hasPrimaryWorkspace && recipeHost);
  const drawerMode = canSwitchToRecipe ? view._reviewDrawerMode : 'primary';
  const primaryLabel = readyDecision ? 'READY' : reviewDecision ? 'REVIEW' : 'RECIPE';
  const drawerLabel = drawerMode === 'recipe' ? 'RECIPE' : primaryLabel;
  const drawerKey =
    slotViewReviewDrawerKey({
      run: view._linkedRun,
      readyDecision,
      reviewDecision,
      hasRecipeHost: !!recipeHost,
    }) || (pinnedLinkedRun ? slotViewLoadedRunDrawerKey(view._linkedRun.id) : '');
  const collapsedTitle = readyDecision
    ? 'Open ready workspace'
    : reviewDecision
      ? 'Open review'
      : 'Open recipe';
  const headerContent = canSwitchToRecipe
    ? html`
        <div style="display:flex; gap:4px; margin-left:${spacing.sm};">
          <button
            class="sv-task-panel-close"
            style="${drawerMode === 'primary'
              ? `color:${colors.accent}; border-color:${colors.accent}66;`
              : ''}"
            title=${readyDecision ? 'Show ready workspace' : 'Show review workspace'}
            @click=${() => {
              view._reviewDrawerMode = 'primary';
            }}
          >
            ${primaryLabel}
          </button>
          <button
            class="sv-task-panel-close"
            style="${drawerMode === 'recipe'
              ? `color:${colors.accent}; border-color:${colors.accent}66;`
              : ''}"
            title="Show recipe runs, evidence, and live runner"
            @click=${() => {
              view._reviewDrawerMode = 'recipe';
            }}
          >
            RECIPE
          </button>
        </div>
      `
    : undefined;
  const bodyContent = showRecipeLoading
    ? html`
        <div style="padding:12px; display:flex; flex-direction:column; gap:${spacing.sm};">
          <div
            style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted};"
          >
            Recipe
          </div>
          <div style="font-size:${fonts.sizeSm}; color:${colors.textSecondary};">
            Loading recipe package and evidence…
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div
              style="height:36px; border-radius:${radii.md}; background:${colors.bgCard}; border:1px solid ${colors.bgCardHover};"
            ></div>
            <div
              style="height:36px; border-radius:${radii.md}; background:${colors.bgCard}; border:1px solid ${colors.bgCardHover}; opacity:0.75;"
            ></div>
            <div
              style="height:120px; border-radius:${radii.md}; background:${colors.bgCard}; border:1px solid ${colors.bgCardHover}; opacity:0.6;"
            ></div>
          </div>
        </div>
      `
    : drawerMode === 'recipe' && recipeHost
      ? renderRecipeHostBody(view, recipeHost, selectedRecipeRun, effectiveRecipeJson)
      : readyDecision
        ? html`
            <ready-workspace
              .runId=${view._linkedRun.id}
              .decision=${readyDecision}
              .run=${view._linkedRun}
              .recipeRuns=${view._recipeRuns}
              selectedRecipeRunId=${view._selectedRecipeRunId}
              slotId=${view._isLive ? view.slotId : ''}
              branch=${view._linkedRun.branch ?? ''}
              runner=${view._linkedRun.metrics.runner ?? ''}
              .hideRecipeTab=${canSwitchToRecipe}
              @recipe-complete=${(event: CustomEvent<RecipeCompleteDetail>) => {
                view._handleRecipeExecutionComplete(event.detail);
              }}
              @recipe-artifacts-request=${(event: CustomEvent<RecipeCompleteDetail>) => {
                view._handleRecipeExecutionComplete(event.detail);
              }}
            ></ready-workspace>
          `
        : reviewDecision
          ? html`
              <review-workspace
                .runId=${view._linkedRun.id}
                .decision=${reviewDecision}
                slotId=${view._isLive ? view.slotId : ''}
                branch=${view._linkedRun.branch ?? ''}
                slotBranch=${view._liveGitData?.branch ?? ''}
                @recipe-complete=${(event: CustomEvent<RecipeCompleteDetail>) => {
                  view._handleRecipeExecutionComplete(event.detail);
                }}
                @recipe-artifacts-request=${(event: CustomEvent<RecipeCompleteDetail>) => {
                  view._handleRecipeExecutionComplete(event.detail);
                }}
              ></review-workspace>
            `
          : recipeHost
            ? renderRecipeHostBody(view, recipeHost, selectedRecipeRun, effectiveRecipeJson)
            : html`
                <div
                  style="padding:16px; display:flex; flex-direction:column; gap:${spacing.sm}; color:${colors.textMuted}; font-size:${fonts.sizeSm};"
                >
                  <div
                    style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em;"
                  >
                    Recipe
                  </div>
                  <div>
                    ${pinnedLinkedRun && !view._recipeRunsLoading
                      ? slotViewNoRecipeReplayMessage(view._linkedRun)
                      : html`No recipe artifact for this run yet. Evidence appears here once the
                          worker emits <code>artifacts/recipe.json</code>.`}
                  </div>
                </div>
              `;

  return renderSlotRecipeDrawer({
    reviewPanelOpen: view._reviewPanelOpen,
    reviewFullWidth: view._reviewFullWidth,
    reviewPanelWidth: view._reviewPanelWidth,
    resizing: view._resizing,
    drawerLabel,
    collapsedTitle,
    headerContent,
    recipeExecutionOverlay: view._renderRecipeExecutionOverlay(
      drawerMode === 'recipe' ? recipeHost : readyDecision || reviewDecision ? null : recipeHost,
    ),
    bodyContent,
    onResizeStart: (event) => view._onResizeStart('review', event),
    onToggleFullWidth: () => {
      view._reviewFullWidth = !view._reviewFullWidth;
      view._saveLayout();
    },
    onClose: () => {
      view._reviewFullWidth = false;
      view._reviewPanelOpen = false;
      view._dismissedReviewDrawerKey = drawerKey;
      view._saveLayout();
    },
    onOpen: () => {
      view._reviewPanelOpen = true;
      if (drawerKey === view._dismissedReviewDrawerKey) view._dismissedReviewDrawerKey = '';
      view._saveLayout();
    },
  });
}
